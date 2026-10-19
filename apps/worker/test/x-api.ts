/**
 * XApi: an in-memory api.x.com behind the `Http` interface, for driving the REAL X adapter (@apecheck/sources
 * createX / createSources) without the network. It keeps state the way X does and answers only what was asked:
 *
 *  - every request is authenticated: OAuth 1.0a user context (HMAC-SHA1 verified here independently of
 *    packages/sources/src/oauth1.ts: base string, consumer/token keys, timestamp window, nonce never reused) or the
 *    app Bearer token for reads. Anything else is a 401, and is listed in `authErrors`;
 *  - GET /2/users/:id/mentions: posts that @mention the bot, newer than since_id, newest first, paged (pageSize,
 *    next_token), with only the requested tweet.fields / user.fields and expansions (includes.users, includes.tweets,
 *    a not-found `errors` entry for a deleted parent). `rateLimitNextPage` answers the next paged call with a 429;
 *  - media v2 chunked upload: initialize (JSON) → append (multipart, parsed byte-exact) → finalize (pending) →
 *    STATUS (succeeded); the assembled bytes must match total_bytes;
 *  - POST /2/tweets: a reply must name an existing post; media ids must be uploaded and processed; ≤ 280 characters;
 *    the same text to the same post twice is X's 403 duplicate content. Like X, a reply "Replies to" the replied-to
 *    post's author and every account that post @mentions, minus reply.exclude_reply_user_ids (`replyingTo`); the
 *    author is the leading mention and cannot be excluded (naming it is listed in `badRequests`);
 *  - reads with the Bearer token: /2/users/by/username/:u, /2/users/:id, /2/users/me (user context), /2/tweets/:id;
 *    the bot's own posts with user context: /2/users/:id/tweets (since_id, newest first; findReply).
 */
import { createHmac } from 'node:crypto';
import type { Http, HttpRequest, HttpResponse } from '@apecheck/sources';

export interface XApiUser {
  id: string;
  username: string;
  name: string;
  created_at: string;
  description?: string;
  verified?: boolean;
  url?: string;
  public_metrics?: { followers_count: number; following_count: number; tweet_count: number; listed_count: number };
  entities?: unknown;
}

export interface XApiTweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  conversation_id: string;
  entities?: {
    urls?: { start: number; end: number; url: string; expanded_url: string; display_url: string }[];
    mentions?: { start: number; end: number; username: string; id: string }[];
    cashtags?: { start: number; end: number; tag: string }[];
  };
  referenced_tweets?: { type: 'replied_to' | 'quoted' | 'retweeted'; id: string }[];
  in_reply_to_user_id?: string;
  display_text_range?: [number, number];
}

export interface XApiCreds {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  bearer: string;
}

export interface XApiUpload {
  id: string;
  totalBytes: number;
  mediaType: string;
  segments: Map<number, Buffer>;
  state: 'uploading' | 'pending' | 'succeeded';
  bytes: Buffer | null;
}

export interface XApiPosted {
  id: string;
  text: string;
  inReplyToId: string | null;
  mediaIds: string[];
  /** the uploaded bytes of each media id */
  media: Buffer[];
  /** user ids X notifies as "Replying to …": the replied-to post's author first, then whoever was not excluded */
  replyingTo: string[];
  at: number;
}

export interface XApiRequest {
  method: string;
  url: URL;
  auth: 'oauth1' | 'bearer' | 'none';
  status: number;
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const cpLength = (s: string) => [...s].length;

/** RFC 5849 §3.4 check of an `Authorization: OAuth …` header; null when valid, else why not. */
export function verifyOAuth1(header: string, method: string, url: URL, creds: XApiCreds, now: number, seenNonces: Set<string>): string | null {
  const p: Record<string, string> = {};
  for (const m of header.replace(/^OAuth\s+/, '').matchAll(/([A-Za-z_]+)="([^"]*)"/g)) p[decodeURIComponent(m[1])] = decodeURIComponent(m[2]);
  if (p.oauth_consumer_key !== creds.consumerKey) return 'wrong consumer key';
  if (p.oauth_token !== creds.token) return 'wrong access token';
  if (p.oauth_signature_method !== 'HMAC-SHA1' || p.oauth_version !== '1.0') return 'unsupported signature method';
  const ts = Number(p.oauth_timestamp);
  if (!Number.isInteger(ts) || Math.abs(ts - now / 1000) > 300) return `timestamp ${p.oauth_timestamp} out of window`;
  if (!p.oauth_nonce || seenNonces.has(p.oauth_nonce)) return `nonce ${p.oauth_nonce} reused`;
  const params: [string, string][] = [...url.searchParams.entries()];
  for (const [k, v] of Object.entries(p)) if (k.startsWith('oauth_') && k !== 'oauth_signature') params.push([k, v]);
  const normalised = params
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = `${method.toUpperCase()}&${enc(`${url.protocol}//${url.host}${url.pathname}`)}&${enc(normalised)}`;
  const expected = createHmac('sha1', `${enc(creds.consumerSecret)}&${enc(creds.tokenSecret)}`).update(base).digest('base64');
  if (expected !== p.oauth_signature) return 'bad signature';
  seenNonces.add(p.oauth_nonce);
  return null;
}

/** multipart/form-data → parts by name (byte-exact). Throws on a malformed body. */
export function parseMultipart(body: Buffer, contentType: string): Map<string, { headers: string; data: Buffer }> {
  const b = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!b) throw new Error('no multipart boundary');
  const delim = Buffer.from(`--${b[1] ?? b[2]}`);
  const crlfDelim = Buffer.concat([Buffer.from('\r\n'), delim]);
  const parts = new Map<string, { headers: string; data: Buffer }>();
  if (body.indexOf(delim) !== 0) throw new Error('body does not start with the boundary');
  let pos = delim.length;
  for (;;) {
    const after = body.subarray(pos, pos + 2).toString('latin1');
    if (after === '--') break;
    if (after !== '\r\n') throw new Error('malformed boundary line');
    pos += 2;
    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) throw new Error('part without headers');
    const headers = body.subarray(pos, headEnd).toString('utf8');
    const end = body.indexOf(crlfDelim, headEnd + 4);
    if (end < 0) throw new Error('unterminated part');
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    if (!name) throw new Error('part without a name');
    parts.set(name, { headers, data: Buffer.from(body.subarray(headEnd + 4, end)) });
    pos = end + crlfDelim.length;
  }
  return parts;
}

const TWEET_DEFAULT = ['id', 'text', 'edit_history_tweet_ids'];
const USER_DEFAULT = ['id', 'name', 'username'];

export class XApi {
  readonly users = new Map<string, XApiUser>();
  readonly tweets = new Map<string, XApiTweet>();
  /** posts that mention the bot (served by the mentions timeline) */
  readonly mentionIds: string[] = [];
  readonly uploads = new Map<string, XApiUpload>();
  readonly posted: XApiPosted[] = [];
  readonly requests: XApiRequest[] = [];
  readonly authErrors: string[] = [];
  /** requests the emulator could not route or refused as malformed (a bug on the adapter's side) */
  readonly badRequests: string[] = [];
  /** mentions per page (X: max_results, up to 100) */
  pageSize = 100;
  /** answer the next mentions call that has a pagination_token with a 429 (seconds until the reset) */
  rateLimitNextPage: number | null = null;
  private readonly nonces = new Set<string>();
  private seq: bigint;

  constructor(
    private readonly o: { botId: string; creds: XApiCreds; now?: () => number; firstId?: bigint },
  ) {
    this.seq = o.firstId ?? 1_990_000_000_000_000_000n;
  }

  private now() {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** A fresh snowflake id, newer than every earlier one. */
  nextId(): string {
    this.seq += 1000n;
    return String(this.seq);
  }

  addUser(u: XApiUser): XApiUser {
    this.users.set(u.id, u);
    return u;
  }

  addTweet(t: XApiTweet): XApiTweet {
    this.tweets.set(t.id, t);
    if (t.entities?.mentions?.some(m => m.id === this.o.botId) && t.author_id !== this.o.botId) this.mentionIds.push(t.id);
    return t;
  }

  /** Remove a post (a deleted parent): it is no longer included, and replies to it are refused. */
  deleteTweet(id: string) {
    this.tweets.delete(id);
  }

  readonly http: Http = {
    request: (url: string, req: HttpRequest = {}) => this.handle(url, req),
    json: async <T>(url: string, req?: HttpRequest) => {
      const res = await this.handle(url, req ?? {});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(res.text) as T;
    },
  };

  /* ---------------- plumbing ---------------- */

  private res(url: string, status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
    const text = body === undefined ? '' : JSON.stringify(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      url,
      finalUrl: url,
      headers: { ...(text ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...headers },
      text,
      truncated: false,
      ms: 1,
    };
  }

  private problem(url: string, status: number, title: string, detail: string, headers: Record<string, string> = {}) {
    return this.res(url, status, { title, detail, type: `https://api.x.com/2/problems/${title.toLowerCase().replace(/\s+/g, '-')}`, status }, headers);
  }

  private bad(url: string, why: string) {
    this.badRequests.push(why);
    return this.problem(url, 400, 'Invalid Request', why);
  }

  private async handle(raw: string, req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(raw);
    const method = req.method ?? 'GET';
    if (url.protocol !== 'https:' || url.host !== 'api.x.com') throw new Error(`XApi only serves https://api.x.com (got ${url.origin})`);
    const header = req.headers?.authorization ?? '';
    let auth: XApiRequest['auth'] = 'none';
    let authError: string | null = 'no Authorization header';
    if (header.startsWith('OAuth ')) {
      auth = 'oauth1';
      authError = verifyOAuth1(header, method, url, this.o.creds, this.now(), this.nonces);
    } else if (header.startsWith('Bearer ')) {
      auth = 'bearer';
      authError = header === `Bearer ${this.o.creds.bearer}` && method === 'GET' ? null : 'bad Bearer token (or a write with it)';
    }
    const record: XApiRequest = { method, url, auth, status: 0 };
    this.requests.push(record);
    let out: HttpResponse;
    if (authError) {
      this.authErrors.push(`${method} ${url.pathname}: ${authError}`);
      out = this.problem(raw, 401, 'Unauthorized', 'Unauthorized');
    } else {
      try {
        out = await this.route(raw, url, method, req, auth);
      } catch (e) {
        out = this.bad(raw, `${method} ${url.pathname}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    record.status = out.status;
    return out;
  }

  private route(raw: string, url: URL, method: string, req: HttpRequest, auth: XApiRequest['auth']): HttpResponse {
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/2\/users\/(\d+)\/mentions$/.exec(p))) return this.mentions(raw, url, m[1]);
    if (method === 'GET' && (m = /^\/2\/users\/(\d+)\/tweets$/.exec(p))) {
      if (auth !== 'oauth1') return this.problem(raw, 403, 'Unsupported Authentication', 'the bot reads its own posts with user context');
      return this.userTweets(raw, url, m[1]);
    }
    if (method === 'GET' && p === '/2/users/me') {
      if (auth !== 'oauth1') return this.problem(raw, 403, 'Unsupported Authentication', 'users/me needs user context');
      return this.res(raw, 200, { data: this.projectUser(this.users.get(this.o.botId)!, new Set()) });
    }
    if (method === 'GET' && (m = /^\/2\/users\/by\/username\/([A-Za-z0-9_]{1,15})$/.exec(p))) {
      const u = [...this.users.values()].find(x => x.username.toLowerCase() === m![1].toLowerCase());
      return this.userResponse(raw, url, u ?? null, `username: [${m[1]}]`);
    }
    if (method === 'GET' && (m = /^\/2\/users\/(\d+)$/.exec(p))) return this.userResponse(raw, url, this.users.get(m[1]) ?? null, `id: [${m[1]}]`);
    if (method === 'GET' && (m = /^\/2\/tweets\/(\d+)$/.exec(p))) return this.tweetResponse(raw, url, m[1]);
    if (method === 'POST' && p === '/2/media/upload/initialize') return this.mediaInit(raw, req);
    if (method === 'POST' && (m = /^\/2\/media\/upload\/(\d+)\/append$/.exec(p))) return this.mediaAppend(raw, m[1], req);
    if (method === 'POST' && (m = /^\/2\/media\/upload\/(\d+)\/finalize$/.exec(p))) return this.mediaFinalize(raw, m[1]);
    if (method === 'GET' && p === '/2/media/upload' && url.searchParams.get('command') === 'STATUS') return this.mediaStatus(raw, url.searchParams.get('media_id') ?? '');
    if (method === 'POST' && p === '/2/tweets') return this.createTweet(raw, req, auth);
    this.badRequests.push(`no route: ${method} ${p}`);
    return this.problem(raw, 404, 'Not Found Error', `no route ${method} ${p}`);
  }

  private jsonBody(req: HttpRequest): Record<string, unknown> {
    if (!/^application\/json/i.test(req.headers?.['content-type'] ?? '')) throw new Error('expected a JSON body');
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (req.body ?? '');
    return JSON.parse(text) as Record<string, unknown>;
  }

  /* ---------------- field projection ---------------- */

  private fields(url: URL, name: string): Set<string> {
    return new Set((url.searchParams.get(name) ?? '').split(',').filter(Boolean));
  }

  private projectTweet(t: XApiTweet, fields: Set<string>): Record<string, unknown> {
    const out: Record<string, unknown> = { id: t.id, text: t.text, edit_history_tweet_ids: [t.id] };
    for (const f of fields) {
      if (TWEET_DEFAULT.includes(f)) continue;
      const v = (t as unknown as Record<string, unknown>)[f];
      if (v !== undefined) out[f] = v;
    }
    return out;
  }

  private projectUser(u: XApiUser, fields: Set<string>): Record<string, unknown> {
    const out: Record<string, unknown> = { id: u.id, name: u.name, username: u.username };
    for (const f of fields) {
      if (USER_DEFAULT.includes(f)) continue;
      const v = (u as unknown as Record<string, unknown>)[f];
      if (v !== undefined) out[f] = v;
    }
    return out;
  }

  /** data + includes + errors for a list of posts, honouring expansions / fields like X. */
  private expand(url: URL, list: XApiTweet[]) {
    const expansions = this.fields(url, 'expansions');
    const tf = this.fields(url, 'tweet.fields');
    const uf = this.fields(url, 'user.fields');
    const userIds = new Set<string>();
    const included: XApiTweet[] = [];
    const errors: Record<string, unknown>[] = [];
    if (expansions.has('author_id')) for (const t of list) userIds.add(t.author_id);
    if (expansions.has('entities.mentions.username')) for (const t of list) for (const m of t.entities?.mentions ?? []) if (this.users.has(m.id)) userIds.add(m.id);
    if (expansions.has('referenced_tweets.id')) {
      for (const t of list) {
        for (const r of t.referenced_tweets ?? []) {
          const ref = this.tweets.get(r.id);
          if (!ref) {
            errors.push({
              value: r.id,
              detail: `Could not find tweet with referenced_tweets.id: [${r.id}].`,
              title: 'Not Found Error',
              resource_type: 'tweet',
              parameter: 'referenced_tweets.id',
              resource_id: r.id,
              type: 'https://api.twitter.com/2/problems/resource-not-found',
            });
          } else if (!included.some(x => x.id === ref.id)) {
            included.push(ref);
            if (expansions.has('referenced_tweets.id.author_id')) userIds.add(ref.author_id);
          }
        }
      }
    }
    const includes: Record<string, unknown> = {};
    const users = [...userIds].map(id => this.users.get(id)).filter((u): u is XApiUser => !!u);
    if (users.length) includes.users = users.map(u => this.projectUser(u, uf));
    if (included.length) includes.tweets = included.map(t => this.projectTweet(t, tf));
    return { data: list.map(t => this.projectTweet(t, tf)), includes, errors };
  }

  /* ---------------- endpoints ---------------- */

  private mentions(raw: string, url: URL, userId: string): HttpResponse {
    if (userId !== this.o.botId) return this.bad(raw, `mentions of ${userId}, not of the bot ${this.o.botId}`);
    const since = url.searchParams.get('since_id');
    const token = url.searchParams.get('pagination_token');
    const max = Number(url.searchParams.get('max_results') ?? 10);
    if (!Number.isInteger(max) || max < 5 || max > 100) return this.bad(raw, `max_results ${max} not in 5..100`);
    if (token && this.rateLimitNextPage != null) {
      const reset = Math.ceil(this.now() / 1000) + this.rateLimitNextPage;
      this.rateLimitNextPage = null;
      return this.problem(raw, 429, 'Too Many Requests', 'Too Many Requests', {
        'x-rate-limit-limit': '180',
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': String(reset),
      });
    }
    const all = this.mentionIds
      .map(id => this.tweets.get(id))
      .filter((t): t is XApiTweet => !!t && (!since || BigInt(t.id) > BigInt(since)))
      .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
    const offset = token ? Number(Buffer.from(token, 'base64url').toString('utf8').replace(/^page:/, '')) : 0;
    if (!Number.isInteger(offset) || offset < 0) return this.bad(raw, `bad pagination_token ${token}`);
    const size = Math.min(max, this.pageSize);
    const page = all.slice(offset, offset + size);
    if (!page.length) return this.res(raw, 200, { meta: { result_count: 0 } });
    const { data, includes, errors } = this.expand(url, page);
    const next = offset + size < all.length ? Buffer.from(`page:${offset + size}`).toString('base64url') : null;
    return this.res(raw, 200, {
      data,
      ...(Object.keys(includes).length ? { includes } : {}),
      ...(errors.length ? { errors } : {}),
      meta: { result_count: page.length, newest_id: page[0].id, oldest_id: page[page.length - 1].id, ...(next ? { next_token: next } : {}) },
    });
  }

  /** GET /2/users/:id/tweets: that user's posts newer than since_id, newest first, one page (XAdapter.findReply). */
  private userTweets(raw: string, url: URL, userId: string): HttpResponse {
    const since = url.searchParams.get('since_id');
    const max = Number(url.searchParams.get('max_results') ?? 10);
    if (!Number.isInteger(max) || max < 5 || max > 100) return this.bad(raw, `max_results ${max} not in 5..100`);
    const page = [...this.tweets.values()]
      .filter(t => t.author_id === userId && (!since || BigInt(t.id) > BigInt(since)))
      .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
      .slice(0, max);
    if (!page.length) return this.res(raw, 200, { meta: { result_count: 0 } });
    const tf = this.fields(url, 'tweet.fields');
    return this.res(raw, 200, { data: page.map(t => this.projectTweet(t, tf)), meta: { result_count: page.length, newest_id: page[0].id, oldest_id: page[page.length - 1].id } });
  }

  private userResponse(raw: string, url: URL, u: XApiUser | null, what: string): HttpResponse {
    if (!u) return this.res(raw, 200, { errors: [{ value: what, detail: `Could not find user with ${what}.`, title: 'Not Found Error', type: 'https://api.twitter.com/2/problems/resource-not-found' }] });
    return this.res(raw, 200, { data: this.projectUser(u, this.fields(url, 'user.fields')) });
  }

  private tweetResponse(raw: string, url: URL, id: string): HttpResponse {
    const t = this.tweets.get(id);
    if (!t) return this.res(raw, 200, { errors: [{ value: id, detail: `Could not find tweet with id: [${id}].`, title: 'Not Found Error', type: 'https://api.twitter.com/2/problems/resource-not-found' }] });
    const { data, includes } = this.expand(url, [t]);
    return this.res(raw, 200, { data: data[0], ...(Object.keys(includes).length ? { includes } : {}) });
  }

  private mediaInit(raw: string, req: HttpRequest): HttpResponse {
    const b = this.jsonBody(req);
    const total = Number(b.total_bytes);
    if (b.media_type !== 'image/png' && b.media_type !== 'image/jpeg') return this.bad(raw, `media_type ${String(b.media_type)}`);
    if (b.media_category !== 'tweet_image') return this.bad(raw, `media_category ${String(b.media_category)}`);
    if (!Number.isInteger(total) || total <= 0 || total > 5 * 1024 * 1024) return this.bad(raw, `total_bytes ${String(b.total_bytes)}`);
    const id = this.nextId();
    this.uploads.set(id, { id, totalBytes: total, mediaType: String(b.media_type), segments: new Map(), state: 'uploading', bytes: null });
    return this.res(raw, 200, { data: { id, media_key: `3_${id}`, expires_after_secs: 86400 } });
  }

  private mediaAppend(raw: string, id: string, req: HttpRequest): HttpResponse {
    const up = this.uploads.get(id);
    if (!up || up.state !== 'uploading') return this.bad(raw, `append to unknown or finalized media ${id}`);
    if (!Buffer.isBuffer(req.body)) return this.bad(raw, 'append body is not raw bytes');
    const parts = parseMultipart(req.body, req.headers?.['content-type'] ?? '');
    const index = Number(parts.get('segment_index')?.data.toString('utf8'));
    const media = parts.get('media');
    if (!Number.isInteger(index) || index < 0 || index > 999) return this.bad(raw, 'segment_index missing or invalid');
    if (!media || !media.data.length) return this.bad(raw, 'media part missing');
    if (media.data.length > 5 * 1024 * 1024) return this.bad(raw, 'segment over 5 MB');
    up.segments.set(index, media.data);
    return this.res(raw, 200, undefined);
  }

  private mediaFinalize(raw: string, id: string): HttpResponse {
    const up = this.uploads.get(id);
    if (!up || up.state !== 'uploading') return this.bad(raw, `finalize of unknown or finalized media ${id}`);
    const chunks: Buffer[] = [];
    for (let i = 0; i < up.segments.size; i++) {
      const c = up.segments.get(i);
      if (!c) return this.bad(raw, `segment ${i} missing`);
      chunks.push(c);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== up.totalBytes) return this.bad(raw, `got ${bytes.length} bytes, initialize said ${up.totalBytes}`);
    up.bytes = bytes;
    up.state = 'pending';
    return this.res(raw, 200, {
      data: { id, media_key: `3_${id}`, size: bytes.length, expires_after_secs: 86400, processing_info: { state: 'pending', check_after_secs: 1 } },
    });
  }

  private mediaStatus(raw: string, id: string): HttpResponse {
    const up = this.uploads.get(id);
    if (!up || up.state === 'uploading') return this.bad(raw, `STATUS of unknown or unfinalized media ${id}`);
    up.state = 'succeeded';
    return this.res(raw, 200, { data: { id, media_key: `3_${id}`, processing_info: { state: 'succeeded', progress_percent: 100 } } });
  }

  private createTweet(raw: string, req: HttpRequest, auth: XApiRequest['auth']): HttpResponse {
    if (auth !== 'oauth1') return this.problem(raw, 403, 'Unsupported Authentication', 'Posting needs OAuth 1.0a user context');
    const b = this.jsonBody(req) as {
      text?: unknown;
      reply?: { in_reply_to_tweet_id?: unknown; exclude_reply_user_ids?: unknown };
      media?: { media_ids?: unknown };
    };
    const text = typeof b.text === 'string' ? b.text : '';
    if (!text.trim()) return this.bad(raw, 'empty text');
    if (cpLength(text) > 280) return this.problem(raw, 403, 'Forbidden', 'Your Tweet text is too long.');
    const inReplyTo = b.reply?.in_reply_to_tweet_id;
    if (inReplyTo !== undefined && (typeof inReplyTo !== 'string' || !this.tweets.has(inReplyTo))) {
      return this.problem(raw, 400, 'Invalid Request', 'The `reply.in_reply_to_tweet_id` query parameter value is not a valid Post');
    }
    const exclude = b.reply?.exclude_reply_user_ids ?? [];
    if (!Array.isArray(exclude) || exclude.some(id => typeof id !== 'string' || !/^\d{1,19}$/.test(id))) {
      return this.bad(raw, `reply.exclude_reply_user_ids ${JSON.stringify(exclude).slice(0, 80)}`);
    }
    const replyTo = typeof inReplyTo === 'string' ? this.tweets.get(inReplyTo)! : null;
    if (replyTo && exclude.includes(replyTo.author_id)) {
      // X: the leading @mention can't be removed (the reply would lose its in-reply-to); flag it as an adapter bug
      this.badRequests.push(`exclude_reply_user_ids names ${replyTo.author_id}, the author of the post being replied to`);
    }
    const mediaIds = b.media?.media_ids ?? [];
    if (!Array.isArray(mediaIds) || mediaIds.some(id => typeof id !== 'string' || this.uploads.get(id)?.state !== 'succeeded')) {
      return this.problem(raw, 400, 'Invalid Request', 'Your media IDs are invalid.');
    }
    if (this.posted.some(p => p.text === text && p.inReplyToId === (inReplyTo ?? null))) {
      return this.problem(raw, 403, 'Forbidden', 'You are not allowed to create a Tweet with duplicate content.');
    }
    const id = this.nextId();
    this.tweets.set(id, {
      id,
      text,
      author_id: this.o.botId,
      created_at: new Date(this.now()).toISOString(),
      conversation_id: replyTo?.conversation_id ?? id,
      ...(replyTo ? { referenced_tweets: [{ type: 'replied_to' as const, id: replyTo.id }], in_reply_to_user_id: replyTo.author_id } : {}),
    });
    const chain = replyTo ? [replyTo.author_id, ...(replyTo.entities?.mentions ?? []).map(m => m.id)] : [];
    const replyingTo = chain.filter((u, i) => chain.indexOf(u) === i && u !== this.o.botId && (i === 0 || !exclude.includes(u)));
    this.posted.push({
      id,
      text,
      inReplyToId: replyTo?.id ?? null,
      mediaIds: mediaIds as string[],
      media: (mediaIds as string[]).map(m => this.uploads.get(m)!.bytes!),
      replyingTo,
      at: this.now(),
    });
    return this.res(raw, 201, { data: { id, text, edit_history_tweet_ids: [id] } });
  }

  /* ---------------- building posts the way X delivers them ---------------- */

  /** A post by `author`; `links` maps each t.co link written in `text` to the URL it expands to. */
  post(author: XApiUser, text: string, o: { links?: Record<string, string>; replyTo?: XApiTweet; displayFrom?: number } = {}): XApiTweet {
    const id = this.nextId();
    const cp = (i: number) => cpLength(text.slice(0, i));
    const mentions = [...text.matchAll(/@([A-Za-z0-9_]{1,15})/g)].flatMap(m => {
      const u = [...this.users.values()].find(x => x.username.toLowerCase() === m[1].toLowerCase());
      return u ? [{ start: cp(m.index!), end: cp(m.index! + m[0].length), username: u.username, id: u.id }] : [];
    });
    const urls = Object.entries(o.links ?? {}).map(([tco, expanded]) => {
      const at = text.indexOf(tco);
      if (at < 0) throw new Error(`${tco} is not in the text`);
      return { start: cp(at), end: cp(at + tco.length), url: tco, expanded_url: expanded, display_url: expanded.replace(/^https?:\/\//, '').slice(0, 26) };
    });
    const t: XApiTweet = {
      id,
      text,
      author_id: author.id,
      created_at: new Date(this.now()).toISOString(),
      conversation_id: o.replyTo?.conversation_id ?? id,
      entities: { ...(mentions.length ? { mentions } : {}), ...(urls.length ? { urls } : {}) },
      display_text_range: [o.displayFrom ?? 0, cpLength(text)],
      ...(o.replyTo ? { referenced_tweets: [{ type: 'replied_to' as const, id: o.replyTo.id }], in_reply_to_user_id: o.replyTo.author_id } : {}),
    };
    return this.addTweet(t);
  }

  /**
   * A reply to `parent` typed by `author`: X puts "@<parent author> " (and the parent's other @mentions) before what
   * the author typed, and the display range starts after that prefix.
   */
  reply(parent: XApiTweet, author: XApiUser, typed: string, links?: Record<string, string>): XApiTweet {
    const handles = [this.users.get(parent.author_id)?.username, ...(parent.entities?.mentions ?? []).map(m => m.username)]
      .filter((h, i, a): h is string => !!h && a.indexOf(h) === i && h.toLowerCase() !== author.username.toLowerCase());
    const prefix = handles.map(h => `@${h} `).join('');
    return this.post(author, prefix + typed, { links, replyTo: parent, displayFrom: cpLength(prefix) });
  }
}

/** One Http for createSources(): api.x.com goes to the emulator, everything else to `rest`. */
export function routeHttp(x: Http, rest: Http): Http {
  const pick = (url: string) => (new URL(url).host === 'api.x.com' ? x : rest);
  return {
    request: (url, req) => pick(url).request(url, req),
    json: (url, req) => pick(url).json(url, req),
  };
}
