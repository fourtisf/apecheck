/**
 * X API v2.
 *  - Reads (posts, accounts): app-only Bearer token (X_BEARER_TOKEN).
 *  - The bot (M2): mentions() is an owned read and reply() / media upload post as the bot, both signed with
 *    OAuth 1.0a user context (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET; see ../oauth1.ts).
 *    mentions() falls back to the Bearer token when only that is set.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Env } from '@apecheck/core';
import { warnOnce } from '@apecheck/core/node';
import type { Http, HttpResponse, XPost, XSource, XUser } from '../types';
import { HttpError } from '../http';
import { formBody, signRequest, type OAuth1Credentials } from '../oauth1';
import { ErrorState, errMsg, uniq } from '../util';

export const X_API = 'https://api.x.com/2';
const TIMEOUT_MS = 10_000;
export const X_USER_FIELDS = 'created_at,public_metrics,verified,description,entities,url,pinned_tweet_id,username,name';
/** note_tweet carries the full text (and entities) of posts longer than 280 characters */
export const X_TWEET_FIELDS = 'created_at,entities,conversation_id,referenced_tweets,author_id,note_tweet';

/* ---- bot (M2) ---- */
export const X_MENTION_EXPANSIONS = 'author_id,referenced_tweets.id,referenced_tweets.id.author_id,entities.mentions.username';
export const X_MENTION_TWEET_FIELDS =
  'created_at,entities,conversation_id,referenced_tweets,author_id,in_reply_to_user_id,display_text_range,note_tweet';
export const X_MENTION_USER_FIELDS = 'created_at,username,name,public_metrics,verified,description,entities,url';
/** pages of 100 mentions followed per mentions() call (only when since_id is set) */
export const MENTION_MAX_PAGES = 5;
/** media append chunk size (X accepts up to 5 MB per chunk; twitter-api-v2 uses 1 MB) */
export const MEDIA_CHUNK_BYTES = 1024 * 1024;
/** STATUS polls after finalize: each wait is check_after_secs clamped to 1–10 s, at most this many, at most 60 s */
export const MEDIA_MAX_POLLS = 10;
const MEDIA_MAX_WAIT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 30_000;
/** back-off when a 429 carries no usable reset header */
const DEFAULT_BACKOFF_MS = 60_000;
const RE_ID = /^\d{1,25}$/;

const UrlEntityZ = z.object({ url: z.string().optional(), expanded_url: z.string().optional(), unwound_url: z.string().optional() });
const EntitiesZ = z
  .object({
    urls: z.array(UrlEntityZ),
    mentions: z.array(z.object({ username: z.string() })),
    cashtags: z.array(z.object({ tag: z.string() })),
  })
  .partial();
const UserZ = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().optional().default(''),
  created_at: z.string().nullish(),
  description: z.string().nullish(),
  verified: z.boolean().nullish(),
  pinned_tweet_id: z.string().nullish(),
  public_metrics: z.object({ followers_count: z.number().nullish(), following_count: z.number().nullish() }).partial().nullish(),
  entities: z
    .object({
      url: z.object({ urls: z.array(UrlEntityZ) }).partial(),
      description: z.object({ urls: z.array(UrlEntityZ) }).partial(),
    })
    .partial()
    .nullish(),
});
const TweetZ = z.object({
  id: z.string(),
  text: z.string(),
  author_id: z.string().optional(),
  created_at: z.string().nullish(),
  conversation_id: z.string().nullish(),
  entities: EntitiesZ.nullish(),
  referenced_tweets: z.array(z.object({ type: z.string(), id: z.string() })).nullish(),
  note_tweet: z.object({ text: z.string(), entities: EntitiesZ.nullish() }).nullish(),
  // mention-only fields: an odd value must not drop the post
  in_reply_to_user_id: z.string().nullish().catch(null),
  display_text_range: z.array(z.number()).nullish().catch(null),
});
const IncludesZ = z
  .object({ users: z.array(z.unknown()), tweets: z.array(z.unknown()) })
  .partial()
  .nullish();
const ErrorsZ = z.array(z.object({ title: z.string().optional(), detail: z.string().optional() })).nullish();
const TweetResponseZ = z.object({ data: TweetZ.nullish(), includes: IncludesZ, errors: ErrorsZ });
const UserResponseZ = z.object({ data: UserZ.nullish(), includes: IncludesZ, errors: ErrorsZ });
const MentionsResponseZ = z.object({
  data: z.array(z.unknown()).nullish(),
  includes: IncludesZ,
  errors: ErrorsZ,
  meta: z
    .object({ newest_id: z.string().nullish(), oldest_id: z.string().nullish(), result_count: z.number().nullish(), next_token: z.string().nullish() })
    .partial()
    .nullish(),
});
const IdDataZ = z.object({ data: z.object({ id: z.string().regex(RE_ID) }) });
const ProcessingInfoZ = z.object({
  state: z.string(),
  check_after_secs: z.number().nullish(),
  progress_percent: z.number().nullish(),
  error: z.object({ code: z.number().nullish(), name: z.string().nullish(), message: z.string().nullish() }).partial().nullish(),
});
const MediaResponseZ = z.object({ data: z.object({ id: z.string().regex(RE_ID).optional(), processing_info: ProcessingInfoZ.nullish() }) });

type XUserRaw = z.infer<typeof UserZ>;
type XTweetRaw = z.infer<typeof TweetZ>;

const expanded = (u: z.infer<typeof UrlEntityZ>) => u.unwound_url || u.expanded_url || null;

export function mapUser(u: XUserRaw, pinnedText: string | null = null): XUser {
  return {
    id: u.id,
    handle: u.username,
    name: u.name,
    createdAt: u.created_at ?? null,
    followers: u.public_metrics?.followers_count ?? null,
    following: u.public_metrics?.following_count ?? null,
    verified: u.verified ?? null,
    description: u.description ?? null,
    url: (u.entities?.url?.urls ?? []).map(expanded).find(Boolean) ?? null,
    bioUrls: uniq((u.entities?.description?.urls ?? []).map(expanded).filter((x): x is string => !!x)),
    pinnedTweetId: u.pinned_tweet_id ?? null,
    pinnedText,
  };
}

function parseIncludedUsers(list: unknown[] | undefined): XUserRaw[] {
  return (list ?? []).map(u => UserZ.safeParse(u)).filter(r => r.success).map(r => r.data);
}
function parseIncludedTweets(list: unknown[] | undefined): XTweetRaw[] {
  return (list ?? []).map(t => TweetZ.safeParse(t)).filter(r => r.success).map(r => r.data);
}

export function mapPost(t: XTweetRaw, users: XUserRaw[]): XPost {
  const ents = [t.entities, t.note_tweet?.entities].filter((e): e is NonNullable<typeof e> => !!e);
  // the post's own photo/video links are not project links
  const ownMedia = new RegExp(`/status/${t.id}/(photo|video)/`, 'i');
  const urls = uniq(
    ents.flatMap(e => (e.urls ?? []).map(expanded)).filter((u): u is string => !!u && !ownMedia.test(u)),
  );
  const authorRaw = users.find(u => u.id === t.author_id) ?? null;
  const author = authorRaw ? mapUser(authorRaw) : null;
  return {
    id: t.id,
    text: t.note_tweet?.text ?? t.text,
    authorId: t.author_id ?? '',
    authorHandle: author?.handle ?? null,
    authorName: author?.name ?? null,
    createdAt: t.created_at ?? null,
    conversationId: t.conversation_id ?? null,
    urls,
    mentions: uniq(ents.flatMap(e => (e.mentions ?? []).map(m => m.username))),
    cashtags: uniq(ents.flatMap(e => (e.cashtags ?? []).map(c => c.tag.toUpperCase()))),
    replyToId: t.referenced_tweets?.find(r => r.type === 'replied_to')?.id ?? null,
    quotedId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id ?? null,
    author,
  };
}

/** UTF-16 index of code point `cp` in `s` (X counts display_text_range in code points). */
function cpIndex(s: string, cp: number): number {
  let i = 0;
  for (let n = 0; n < cp && i < s.length; n++) i += s.codePointAt(i)! > 0xffff ? 2 : 1;
  return i;
}

/**
 * display_text_range as JS indices into the mapped text. For long posts the mapped text is note_tweet.text and
 * X's range describes the truncated `text`: keep the same @mention prefix when the full text starts with it.
 */
function displayRange(t: XTweetRaw, text: string): [number, number] | null {
  const r = t.display_text_range;
  if (!r || r.length !== 2) return null;
  const start = cpIndex(t.text, Math.max(0, r[0]));
  if (text === t.text) return [start, Math.max(start, cpIndex(t.text, r[1]))];
  const prefix = t.text.slice(0, start);
  return [text.startsWith(prefix) ? prefix.length : 0, text.length];
}

/** mapPost plus the mention-only fields; the replied-to parent comes from the same response's includes. */
export function mapMention(t: XTweetRaw, users: XUserRaw[], tweets: XTweetRaw[], withParent = true): XPost {
  const post = mapPost(t, users);
  post.displayTextRange = displayRange(t, post.text);
  post.inReplyToUserId = t.in_reply_to_user_id ?? null;
  if (withParent) {
    const parent = post.replyToId ? tweets.find(x => x.id === post.replyToId) : undefined;
    post.repliedTo = parent ? mapMention(parent, users, tweets, false) : null;
  }
  return post;
}

/** Numeric ids compare by length first (no BigInt needed for ≤ 25 digits). */
const byIdAsc = (a: XPost, b: XPost) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** multipart/form-data body; Buffer values are sent as a file part (application/octet-stream). */
export function multipartBody(parts: [string, string | Buffer][], boundary = `ApeCheck${randomBytes(12).toString('hex')}`): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const [name, value] of parts) {
    const file = Buffer.isBuffer(value);
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"` +
          (file ? `; filename="blob"\r\nContent-Type: application/octet-stream` : '') +
          '\r\n\r\n',
      ),
      file ? value : Buffer.from(value, 'utf8'),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * When a 429 may be retried (epoch ms): the latest reset among the exhausted windows (15-minute endpoint window,
 * 24-hour user / app caps on posting), else x-rate-limit-reset, else now + 60 s.
 */
export function rateLimitUntil(h: Record<string, string>, now: number): number {
  const windows = [
    ['x-rate-limit-remaining', 'x-rate-limit-reset'],
    ['x-user-limit-24hour-remaining', 'x-user-limit-24hour-reset'],
    ['x-app-limit-24hour-remaining', 'x-app-limit-24hour-reset'],
  ];
  let until = 0;
  for (const [remaining, reset] of windows) {
    const r = Number(h[reset]);
    if (h[remaining] === '0' && r > 0) until = Math.max(until, r * 1000);
  }
  if (!until) {
    const r = Number(h['x-rate-limit-reset']);
    if (r > 0) until = r * 1000;
  }
  return until > now ? until : now + DEFAULT_BACKOFF_MS;
}

/** "detail" / "title" / errors[0].message of an X error body */
function xErrorDetail(text: string): string | null {
  try {
    const j = JSON.parse(text) as { detail?: unknown; title?: unknown; errors?: { message?: unknown; detail?: unknown }[] };
    const d = j.detail ?? j.errors?.[0]?.message ?? j.errors?.[0]?.detail ?? j.title;
    return typeof d === 'string' && d ? d.slice(0, 200) : null;
  } catch {
    return null;
  }
}

type XEnv = Pick<
  Env,
  'X_BEARER_TOKEN' | 'X_API_KEY' | 'X_API_SECRET' | 'X_ACCESS_TOKEN' | 'X_ACCESS_SECRET' | 'X_BOT_USER_ID' | 'X_BOT_HANDLE'
>;

/** Test hooks; production uses the defaults. */
export interface XOptions {
  sleep?: (ms: number) => Promise<void>;
  /** epoch ms */
  now?: () => number;
  nonce?: () => string;
  boundary?: () => string;
}

type ReadAuth = 'oauth1' | 'bearer';
interface ApiCall {
  auth?: ReadAuth;
  json?: unknown;
  multipart?: { body: Buffer; contentType: string };
  timeoutMs?: number;
  maxBytes?: number;
}

export class XAdapter implements XSource {
  readonly configured: boolean;
  readonly canPost: boolean;
  private readonly errors = new ErrorState('x');
  private readonly creds: OAuth1Credentials | null;
  /** endpoint family → epoch ms until which X said to back off (429) */
  private readonly backoff = new Map<string, number>();
  private botId: Promise<string | null> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly env: XEnv, private readonly http: Http, private readonly opts: XOptions = {}) {
    this.configured = !!env.X_BEARER_TOKEN;
    this.canPost = !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET);
    this.creds = this.canPost
      ? { consumerKey: env.X_API_KEY!, consumerSecret: env.X_API_SECRET!, token: env.X_ACCESS_TOKEN!, tokenSecret: env.X_ACCESS_SECRET! }
      : null;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    if (!this.configured) warnOnce('x', 'X API not configured (X_BEARER_TOKEN empty): post and account lookups are skipped');
  }

  get lastError() {
    return this.errors.lastError;
  }

  /** parsed JSON, or null for 404; throws with a readable reason otherwise */
  private async get(path: string): Promise<unknown> {
    const res = await this.http.request(`${X_API}${path}`, {
      headers: { authorization: `Bearer ${this.env.X_BEARER_TOKEN}`, accept: 'application/json' },
      timeoutMs: TIMEOUT_MS,
    });
    if (res.status === 404) return null;
    if (res.status === 429) {
      const reset = Number(res.headers['x-rate-limit-reset']);
      throw new Error(`rate limited${Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : ''}`);
    }
    if (!res.ok) throw new HttpError(res.status, res.finalUrl, res.text.slice(0, 300), res.headers);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new Error('bad JSON from api.x.com');
    }
  }

  private noData(op: string, errors: z.infer<typeof ErrorsZ>): null {
    const e = errors?.[0];
    if (e) this.errors.fail(op, new Error(e.detail ?? e.title ?? 'no data'));
    return null;
  }

  async getPost(id: string): Promise<XPost | null> {
    if (!this.configured || !/^\d{1,25}$/.test(id)) return null;
    try {
      const raw = await this.get(
        `/tweets/${id}?expansions=author_id,referenced_tweets.id&tweet.fields=${X_TWEET_FIELDS}&user.fields=${X_USER_FIELDS}`,
      );
      if (raw == null) return null;
      const res = TweetResponseZ.parse(raw);
      if (!res.data) return this.noData('getPost', res.errors);
      return mapPost(res.data, parseIncludedUsers(res.includes?.users));
    } catch (e) {
      this.errors.fail('getPost', e);
      return null;
    }
  }

  private async user(op: string, path: string): Promise<XUser | null> {
    try {
      const raw = await this.get(`${path}?user.fields=${X_USER_FIELDS}&expansions=pinned_tweet_id&tweet.fields=created_at,note_tweet`);
      if (raw == null) return null;
      const res = UserResponseZ.parse(raw);
      if (!res.data) return this.noData(op, res.errors);
      const pinned = res.data.pinned_tweet_id
        ? parseIncludedTweets(res.includes?.tweets).find(t => t.id === res.data!.pinned_tweet_id)
        : undefined;
      return mapUser(res.data, pinned ? pinned.note_tweet?.text ?? pinned.text : null);
    } catch (e) {
      this.errors.fail(op, e);
      return null;
    }
  }

  async getUser(handle: string): Promise<XUser | null> {
    const h = handle.trim().replace(/^@/, '');
    if (!this.configured || !/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
    return this.user('getUser', `/users/by/username/${h}`);
  }

  async getUserById(id: string): Promise<XUser | null> {
    if (!this.configured || !/^\d{1,25}$/.test(id)) return null;
    return this.user('getUserById', `/users/${id}`);
  }

  async renameCount(_handle: string): Promise<number | null> {
    warnOnce('x-renames', 'X handle-rename history needs a third-party source (not configured): rename counts are reported as unknown');
    return null;
  }

  /* ---------------- bot (M2): OAuth 1.0a user context ---------------- */

  /** Message when `family` is still inside a 429 back-off window, else null. */
  private backedOff(family: string): string | null {
    const until = this.backoff.get(family);
    if (until == null) return null;
    if (this.now() < until) return `rate limited until ${new Date(until).toISOString()}`;
    this.backoff.delete(family);
    return null;
  }

  private authorization(auth: ReadAuth, method: 'GET' | 'POST', url: string): string {
    if (auth === 'bearer' || !this.creds) return `Bearer ${this.env.X_BEARER_TOKEN}`;
    // JSON and multipart bodies are not part of the signature: only the query and the oauth_* params
    return signRequest(this.creds, { method, url, nonce: this.opts.nonce?.(), timestamp: Math.floor(this.now() / 1000) }).authorization;
  }

  /**
   * One signed call. Parsed JSON (null for an empty body); throws a readable Error otherwise. A 429 also opens
   * a back-off window for `family` (calls inside it fail fast without a request).
   */
  private async api(family: string, method: 'GET' | 'POST', url: string, o: ApiCall = {}): Promise<unknown> {
    const headers: Record<string, string> = { authorization: this.authorization(o.auth ?? 'oauth1', method, url), accept: 'application/json' };
    let body: string | Buffer | undefined;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers['content-type'] = 'application/json';
    } else if (o.multipart) {
      body = o.multipart.body;
      headers['content-type'] = o.multipart.contentType;
    }
    const res: HttpResponse = await this.http.request(url, {
      method,
      headers,
      body,
      timeoutMs: o.timeoutMs ?? TIMEOUT_MS,
      maxBytes: o.maxBytes,
      // a signed request is never replayed to another URL
      redirect: false,
    });
    if (res.status === 429) {
      const until = rateLimitUntil(res.headers, this.now());
      this.backoff.set(family, until);
      throw new Error(`rate limited until ${new Date(until).toISOString()}`);
    }
    if (!res.ok) {
      const detail = xErrorDetail(res.text);
      if (res.status === 403 && /duplicate/i.test(detail ?? res.text)) throw new Error('duplicate content (HTTP 403)');
      throw new Error(`HTTP ${res.status} from api.x.com${detail ? `: ${detail}` : ''}`);
    }
    if (res.truncated) throw new Error('response from api.x.com too large');
    if (!res.text.trim()) return null;
    try {
      return JSON.parse(res.text);
    } catch {
      throw new Error('bad JSON from api.x.com');
    }
  }

  /** X_BOT_USER_ID, else looked up once (GET /2/users/me with the user keys, or X_BOT_HANDLE with the Bearer). */
  private botUserId(auth: ReadAuth): Promise<string | null> {
    const fixed = this.env.X_BOT_USER_ID?.trim();
    if (fixed) {
      if (RE_ID.test(fixed)) return Promise.resolve(fixed);
      this.errors.fail('mentions', new Error('X_BOT_USER_ID must be the numeric user id of the bot account'));
      return Promise.resolve(null);
    }
    this.botId ??= (async () => {
      let id: string | null = null;
      try {
        id = auth === 'oauth1'
          ? IdDataZ.parse(await this.api('users', 'GET', `${X_API}/users/me`)).data.id
          : (await this.getUser(this.env.X_BOT_HANDLE))?.id ?? null;
      } catch (e) {
        this.errors.fail('mentions', new Error(`bot user id lookup failed: ${errMsg(e)}`));
      }
      if (id) warnOnce('x-bot-id', `X_BOT_USER_ID not set: looked up the bot account id (${id}); set X_BOT_USER_ID=${id} to skip the lookup`);
      else this.botId = null; // retry on the next poll
      return id;
    })();
    return this.botId;
  }

  async mentions(sinceId: string | null): Promise<{ posts: XPost[]; newestId: string | null }> {
    const none = { posts: [] as XPost[], newestId: null };
    const auth: ReadAuth | null = this.canPost ? 'oauth1' : this.configured ? 'bearer' : null;
    if (!auth) {
      warnOnce('x-bot', 'X bot not configured (X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET and X_BEARER_TOKEN empty): mentions are not read');
      return none;
    }
    if (auth === 'bearer') warnOnce('x-bot-bearer', 'X OAuth 1.0a keys not set: reading mentions with the app Bearer token; replies are disabled');
    if (sinceId != null && !RE_ID.test(sinceId)) {
      this.errors.fail('mentions', new Error(`invalid since_id ${JSON.stringify(sinceId).slice(0, 40)}`));
      return none;
    }
    const limited = this.backedOff('mentions');
    if (limited) {
      this.errors.fail('mentions', new Error(limited));
      return none;
    }
    const botId = await this.botUserId(auth);
    if (!botId) return none;

    const byId = new Map<string, XPost>();
    let newestId: string | null = null;
    let token: string | null = null;
    // without since_id only the newest page is read (bootstrap: no backlog of old mentions)
    const maxPages = sinceId ? MENTION_MAX_PAGES : 1;
    let page = 0;
    try {
      for (; page < maxPages; page++) {
        const params: [string, string][] = [
          ...(sinceId ? ([['since_id', sinceId]] as [string, string][]) : []),
          ['max_results', '100'],
          ...(token ? ([['pagination_token', token]] as [string, string][]) : []),
          ['expansions', X_MENTION_EXPANSIONS],
          ['tweet.fields', X_MENTION_TWEET_FIELDS],
          ['user.fields', X_MENTION_USER_FIELDS],
        ];
        const url = `${X_API}/users/${botId}/mentions?${formBody(params)}`;
        const res = MentionsResponseZ.parse(await this.api('mentions', 'GET', url, { auth, maxBytes: 8 * 1024 * 1024 }));
        // errors next to data are about expansions (a deleted parent post…); errors alone are about the call
        if (!res.data && res.errors?.[0]) throw new Error(res.errors[0].detail ?? res.errors[0].title ?? 'no data');
        if (page === 0) newestId = res.meta?.newest_id ?? null;
        const users = parseIncludedUsers(res.includes?.users);
        const tweets = parseIncludedTweets(res.includes?.tweets);
        let malformed = 0;
        for (const raw of res.data ?? []) {
          const t = TweetZ.safeParse(raw);
          if (!t.success) malformed++;
          else if (!byId.has(t.data.id)) byId.set(t.data.id, mapMention(t.data, users, tweets));
        }
        if (malformed) this.errors.fail('mentions', new Error(`${malformed} post(s) with an unexpected shape were skipped`));
        token = res.meta?.next_token ?? null;
        if (!token) break;
      }
      if (token && sinceId) {
        this.errors.fail('mentions', new Error(`more than ${maxPages * 100} new mentions: the oldest ones were skipped`));
      }
    } catch (e) {
      this.errors.fail('mentions', e);
      // cut short after the first page: keep the caller's since_id so the unread older pages are read next time
      if (page > 0) newestId = null;
    }
    return { posts: [...byId.values()].sort(byIdAsc), newestId };
  }

  /** v2 chunked upload (initialize → append… → finalize → STATUS polls); returns the media id. Throws. */
  async uploadPng(png: Buffer): Promise<string> {
    if (!this.creds) throw new Error('X OAuth 1.0a keys not configured');
    const limited = this.backedOff('media');
    if (limited) throw new Error(limited);
    const init = IdDataZ.parse(
      await this.api('media', 'POST', `${X_API}/media/upload/initialize`, {
        json: { media_type: 'image/png', total_bytes: png.length, media_category: 'tweet_image' },
      }),
    );
    const id = init.data.id;
    for (let i = 0, offset = 0; offset < png.length; i++, offset += MEDIA_CHUNK_BYTES) {
      const multipart = multipartBody(
        [['segment_index', String(i)], ['media', png.subarray(offset, offset + MEDIA_CHUNK_BYTES)]],
        this.opts.boundary?.(),
      );
      await this.api('media', 'POST', `${X_API}/media/upload/${id}/append`, { multipart, timeoutMs: UPLOAD_TIMEOUT_MS });
    }
    let info = MediaResponseZ.parse(await this.api('media', 'POST', `${X_API}/media/upload/${id}/finalize`)).data.processing_info;
    let waited = 0;
    for (let polls = 0; info && info.state !== 'succeeded'; polls++) {
      if (info.state === 'failed') throw new Error(`media processing failed${info.error?.message ? `: ${info.error.message}` : ''}`);
      const wait = Math.min(10, Math.max(1, info.check_after_secs ?? 1)) * 1000;
      if (polls >= MEDIA_MAX_POLLS || waited + wait > MEDIA_MAX_WAIT_MS) throw new Error('media processing did not finish in time');
      await this.sleep(wait);
      waited += wait;
      const status = await this.api('media', 'GET', `${X_API}/media/upload?${formBody([['command', 'STATUS'], ['media_id', id]])}`);
      info = MediaResponseZ.parse(status).data.processing_info;
    }
    return id;
  }

  async reply(inReplyToId: string, text: string, mediaPng?: Buffer | null): Promise<string | null> {
    if (!this.canPost) {
      warnOnce('x-post', 'X posting not configured (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET empty): the bot does not reply');
      return null;
    }
    if (!RE_ID.test(inReplyToId)) {
      this.errors.fail('reply', new Error(`invalid post id ${JSON.stringify(inReplyToId).slice(0, 40)}`));
      return null;
    }
    if (!text.trim()) {
      this.errors.fail('reply', new Error('empty text'));
      return null;
    }
    const limited = this.backedOff('tweets');
    if (limited) {
      this.errors.fail('reply', new Error(limited));
      return null;
    }
    let mediaId: string | null = null;
    if (mediaPng?.length) {
      try {
        mediaId = await this.uploadPng(mediaPng);
      } catch (e) {
        this.errors.fail('uploadMedia', e);
        console.warn(`[apecheck] WARN x.reply: card upload failed (${errMsg(e)}); replying to ${inReplyToId} without it`);
      }
    }
    try {
      const body = { text, reply: { in_reply_to_tweet_id: inReplyToId }, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) };
      return IdDataZ.parse(await this.api('tweets', 'POST', `${X_API}/tweets`, { json: body })).data.id;
    } catch (e) {
      this.errors.fail('reply', e);
      return null;
    }
  }
}

export function createX(env: XEnv, http: Http, opts: XOptions = {}): XAdapter {
  return new XAdapter(env, http, opts);
}
