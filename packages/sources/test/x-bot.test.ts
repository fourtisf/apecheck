import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createX, MEDIA_CHUNK_BYTES, MENTION_MAX_PAGES, multipartBody, rateLimitUntil, X_MENTION_EXPANSIONS, X_MENTION_TWEET_FIELDS,
  X_MENTION_USER_FIELDS, X_REPLY_EXCLUDE_MAX, type XOptions,
} from '../src/adapters/x';
import { hmacSha1, parseOAuthHeader, signatureBaseString, type OAuth1Credentials, type ParamList } from '../src/oauth1';
import type { XBotSource, XPost } from '../src/types';
import { createSources } from '../src/index';
import { fakeHttp, fixture, testEnv, type FakeHttp, type Handler } from './helpers';

const CREDS: OAuth1Credentials = { consumerKey: 'ck-123', consumerSecret: 'cs-456', token: '1800000000000000000-tok', tokenSecret: 'ts-789' };
const USER_KEYS = { X_API_KEY: CREDS.consumerKey, X_API_SECRET: CREDS.consumerSecret, X_ACCESS_TOKEN: CREDS.token, X_ACCESS_SECRET: CREDS.tokenSecret };
const BOT_ID = '1800000000000000000';
const BOT = { ...USER_KEYS, X_BOT_USER_ID: BOT_ID };
const MEDIA_ID = '1880028106020515840';
const NOW = Date.parse('2026-10-19T10:00:00.000Z');

function setup(env: Record<string, string>, handlers: Handler[], opts: XOptions = {}) {
  let now = NOW;
  const sleeps: number[] = [];
  const http = fakeHttp(...handlers);
  const x = createX(testEnv(env), http, {
    now: () => now,
    sleep: async ms => {
      sleeps.push(ms);
      now += ms;
    },
    ...opts,
  });
  return { x, http, sleeps, advance: (ms: number) => (now += ms) };
}

/** Recompute the OAuth 1.0a signature from the URL query + oauth_* params only (never the body). */
function expectSigned(call: FakeHttp['calls'][number]) {
  expectSignedSince(call, NOW);
}
/** expectSigned for a clock that started at `clockStart` (epoch ms) */
function expectSignedSince(call: FakeHttp['calls'][number], clockStart: number) {
  const header = call.req.headers?.authorization ?? '';
  expect(header).toMatch(/^OAuth /);
  const { oauth_signature, ...oauth } = parseOAuthHeader(header);
  expect(oauth).toMatchObject({
    oauth_consumer_key: CREDS.consumerKey,
    oauth_token: CREDS.token,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
  });
  expect(oauth.oauth_nonce).toMatch(/^[A-Za-z0-9]{32}$/);
  // seconds at send time (the fake clock starts at NOW and moves with the fake sleep)
  expect(Number(oauth.oauth_timestamp)).toBeGreaterThanOrEqual(Math.floor(clockStart / 1000));
  expect(Number(oauth.oauth_timestamp)).toBeLessThan(Math.floor(clockStart / 1000) + 3600);
  const params: ParamList = [...new URL(call.url).searchParams.entries(), ...Object.entries(oauth)];
  const base = signatureBaseString(call.req.method ?? 'GET', call.url, params);
  expect(oauth_signature).toBe(hmacSha1(base, CREDS.consumerSecret, CREDS.tokenSecret));
}

const path = (call: FakeHttp['calls'][number]) => `${call.req.method ?? 'GET'} ${new URL(call.url).pathname}`;

/* ---------------- mentions ---------------- */

const mentionsRoute = (pages: Record<string, unknown>): Handler => url => {
  if (url.pathname !== `/2/users/${BOT_ID}/mentions`) return undefined;
  const page = pages[url.searchParams.get('pagination_token') ?? 'first'];
  return typeof page === 'function' ? page() : page ? { json: page } : undefined;
};
const twoPages = () => mentionsRoute({ first: fixture('x-mentions-page1.json'), '7140dibdnow9c7btw4b0u5ak2r4ptq': fixture('x-mentions-page2.json') });

describe('X bot: mentions()', () => {
  it('owned read with OAuth 1.0a: params, expansions, fields, pagination', async () => {
    const { x, http } = setup(BOT, [twoPages()]);
    const res = await x.mentions!('1846800000000000001');
    expect(http.calls).toHaveLength(2);
    for (const call of http.calls) {
      const u = new URL(call.url);
      expect(u.origin + u.pathname).toBe(`https://api.x.com/2/users/${BOT_ID}/mentions`);
      expect(call.req.method).toBe('GET');
      expect(u.searchParams.get('since_id')).toBe('1846800000000000001');
      expect(u.searchParams.get('max_results')).toBe('100');
      expect(u.searchParams.get('expansions')).toBe('author_id,referenced_tweets.id,referenced_tweets.id.author_id,entities.mentions.username');
      expect(u.searchParams.get('tweet.fields')).toBe(
        'created_at,entities,conversation_id,referenced_tweets,author_id,in_reply_to_user_id,display_text_range,note_tweet',
      );
      expect(u.searchParams.get('user.fields')).toBe('created_at,username,name,public_metrics,verified,description,entities,url');
      expectSigned(call);
    }
    expect(X_MENTION_EXPANSIONS).toContain('referenced_tweets.id.author_id');
    expect(X_MENTION_TWEET_FIELDS).toContain('display_text_range');
    expect(X_MENTION_USER_FIELDS).toContain('created_at');
    expect(new URL(http.calls[0].url).searchParams.has('pagination_token')).toBe(false);
    expect(new URL(http.calls[1].url).searchParams.get('pagination_token')).toBe('7140dibdnow9c7btw4b0u5ak2r4ptq');
    // oldest first across pages; newestId from the first page's meta
    expect(res.posts.map(p => p.id)).toEqual(['1846900000000000050', '1847000000000000100', '1847000000000000200', '1847000000000000300']);
    expect(res.newestId).toBe('1847000000000000300');
    expect(x.lastError).toBeNull();
  });

  it('maps a reply under a project post: author with createdAt, display range, replied-to post with its author', async () => {
    const { x } = setup(BOT, [twoPages()]);
    const { posts } = await x.mentions!('1');
    const m = posts.find(p => p.id === '1847000000000000300')!;
    expect(m).toMatchObject({
      text: '@kairolabs 🚀 @ApeCheckBot check this https://t.co/m3pic9',
      authorId: '1600000000000000002',
      authorHandle: 'degenfren',
      conversationId: '1846629381234567890',
      mentions: ['kairolabs', 'ApeCheckBot'],
      // X's reply prefix (@kairolabs) included: the bot's reply has to leave them out
      mentionUserIds: ['1500000000000000001', BOT_ID],
      urls: [], // the post's own photo link is not a project link
      replyToId: '1846629381234567890',
      inReplyToUserId: '1500000000000000001',
    });
    expect(m.author).toMatchObject({ id: '1600000000000000002', handle: 'degenfren', createdAt: '2026-10-15T08:00:00.000Z', followers: 12 });
    // X counts code points ([11, 36]); the range is converted to JS indices (the rocket is 2 UTF-16 units)
    expect(m.displayTextRange).toEqual([11, 37]);
    expect(m.text.slice(...m.displayTextRange!)).toBe('🚀 @ApeCheckBot check this');
    expect(m.text.slice(0, m.displayTextRange![0])).toBe('@kairolabs ');
    expect(m.repliedTo).toEqual<XPost>({
      id: '1846629381234567890',
      text: 'Kairo v2 is live on mainnet. Trade now https://t.co/abc123 $kairo',
      authorId: '1500000000000000001',
      authorHandle: 'kairolabs',
      authorName: 'Kairo Labs',
      createdAt: '2026-10-18T14:02:11.000Z',
      conversationId: '1846629381234567890',
      urls: ['https://app.kairo.xyz/trade'],
      mentions: [],
      mentionUserIds: [],
      cashtags: ['KAIRO'],
      replyToId: null,
      quotedId: null,
      displayTextRange: [0, 65],
      inReplyToUserId: null,
      author: {
        id: '1500000000000000001',
        handle: 'kairolabs',
        name: 'Kairo Labs',
        createdAt: '2025-03-02T10:00:00.000Z',
        followers: 18234,
        following: 210,
        verified: false,
        description: 'Building Kairo. Docs: https://t.co/docs77',
        url: 'https://kairo.xyz',
        bioUrls: ['https://docs.kairo.xyz'],
        pinnedTweetId: null,
        pinnedText: null,
      },
    });
    expect(m.repliedTo).not.toHaveProperty('repliedTo');
  });

  it('a standalone mention: no reply fields, whole text displayed', async () => {
    const { x } = setup(BOT, [twoPages()]);
    const m = (await x.mentions!('1')).posts.find(p => p.id === '1847000000000000200')!;
    expect(m).toMatchObject({
      authorHandle: 'oldwhale',
      cashtags: ['KAI'],
      mentions: ['ApeCheckBot'],
      replyToId: null,
      inReplyToUserId: null,
      repliedTo: null,
      displayTextRange: [0, m.text.length],
    });
    expect(m.author?.createdAt).toBe('2019-05-01T12:00:00.000Z');
  });

  it('a follow-up under the bot’s own post: the auto-added @ApeCheckBot is before the display range', async () => {
    const { x } = setup(BOT, [twoPages()]);
    const m = (await x.mentions!('1')).posts.find(p => p.id === '1847000000000000100')!;
    expect(m.inReplyToUserId).toBe(BOT_ID);
    expect(m.text.slice(0, m.displayTextRange![0])).toBe('@ApeCheckBot ');
    expect(m.text.slice(m.displayTextRange![0])).toBe('why is the github score so low?');
    expect(m.repliedTo).toMatchObject({ id: '1846999999999999999', authorId: BOT_ID, authorHandle: 'ApeCheckBot', displayTextRange: null });
    expect(m.repliedTo?.text).toMatch(/^LIKELY LARP \(37\/100\)/);
  });

  it('long posts use note_tweet; a deleted parent gives repliedTo null (the errors entry is not a failure)', async () => {
    const { x } = setup(BOT, [twoPages()]);
    const m = (await x.mentions!('1')).posts.find(p => p.id === '1846900000000000050')!;
    expect(m.text).toMatch(/please take a look before people ape in\.$/);
    expect(m.text.length).toBeGreaterThan(400);
    expect(m.displayTextRange).toEqual([11, m.text.length]);
    expect(m.text.slice(0, 11)).toBe('@ghostproj ');
    expect(m.urls).toEqual(['https://ghostproj.io']);
    expect(m.cashtags).toEqual(['GHOST']);
    // note_tweet entities carry no ids: the same accounts, once each
    expect(m.mentionUserIds).toEqual(['1650000000000000009', BOT_ID]);
    expect(m.replyToId).toBe('1846800000000000000');
    expect(m.repliedTo).toBeNull();
    expect(m.inReplyToUserId).toBe('1650000000000000009');
    expect(x.lastError).toBeNull();
  });

  it('mentionUserIds: entity ids, else the user expanded by entities.mentions.username; unknown handles and odd ids left out', async () => {
    const { x } = setup(BOT, [
      mentionsRoute({
        first: {
          data: [
            {
              id: '1847000000000000400',
              text: '@ApeCheckBot @Alpha @beta @ghost @gamma evil.xyz',
              author_id: '1700000000000000003',
              entities: {
                mentions: [
                  { start: 0, end: 12, username: 'ApeCheckBot', id: BOT_ID },
                  { start: 13, end: 19, username: 'Alpha' },
                  { start: 20, end: 25, username: 'beta', id: 'not-an-id' },
                  { start: 26, end: 32, username: 'ghost' },
                  { start: 33, end: 39, username: 'gamma', id: 1900000000000000004 },
                ],
              },
            },
          ],
          includes: {
            users: [
              { id: '1700000000000000003', username: 'oldwhale', name: 'Old Whale' },
              { id: '1900000000000000001', username: 'alpha', name: 'A' },
              { id: '1900000000000000002', username: 'Beta', name: 'B' },
              { id: '1900000000000000004', username: 'gamma', name: 'G' },
            ],
          },
          meta: { result_count: 1, newest_id: '1847000000000000400' },
        },
      }),
    ]);
    const [m] = (await x.mentions!('1')).posts;
    expect(m.mentions).toEqual(['ApeCheckBot', 'Alpha', 'beta', 'ghost', 'gamma']);
    // @ghost is in no entity id and not expanded (suspended / deleted): nobody to leave out
    expect(m.mentionUserIds).toEqual([BOT_ID, '1900000000000000001', '1900000000000000002', '1900000000000000004']);
    expect(x.lastError).toBeNull();
  });

  it('nothing new: empty list, newestId null (the caller keeps its since_id)', async () => {
    const { x } = setup(BOT, [mentionsRoute({ first: { meta: { result_count: 0 } } })]);
    expect(await x.mentions!('1847000000000000300')).toEqual({ posts: [], newestId: null });
    expect(x.lastError).toBeNull();
  });

  it('without since_id only the newest page is read (no backlog on the first poll)', async () => {
    const { x, http } = setup(BOT, [twoPages()]);
    const res = await x.mentions!(null);
    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0].url).searchParams.has('since_id')).toBe(false);
    expect(res.posts.map(p => p.id)).toEqual(['1847000000000000200', '1847000000000000300']);
    expect(res.newestId).toBe('1847000000000000300');
    expect(x.lastError).toBeNull();
  });

  it(`follows at most ${MENTION_MAX_PAGES} pages and says so`, async () => {
    let n = 0;
    const endless: Handler = url => {
      if (!url.pathname.endsWith('/mentions')) return undefined;
      n++;
      const id = String(1847000000000000000n + BigInt(1000 - n));
      return { json: { data: [{ id, text: '@ApeCheckBot hi', author_id: '1700000000000000003' }], meta: { newest_id: id, next_token: `t${n}` } } };
    };
    const { x, http } = setup(BOT, [endless]);
    const res = await x.mentions!('1');
    expect(http.calls).toHaveLength(MENTION_MAX_PAGES);
    expect(res.posts).toHaveLength(MENTION_MAX_PAGES);
    expect(res.newestId).toBe('1847000000000000999');
    expect(res.posts[0].id < res.posts[4].id).toBe(true);
    expect(x.lastError).toBe('x.mentions: more than 500 new mentions: the oldest ones were skipped');
  });

  it('429 on the first page: nothing, lastError with the reset, no request until the reset passes', async () => {
    const reset = Math.floor(NOW / 1000) + 300;
    let limited = true;
    const { x, http, advance } = setup(BOT, [
      url => (limited && url.pathname.endsWith('/mentions') ? { status: 429, json: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(reset) } } : undefined),
      twoPages(),
    ]);
    expect(await x.mentions!('1')).toEqual({ posts: [], newestId: null });
    expect(x.lastError).toBe('x.mentions: rate limited until 2026-10-19T10:05:00.000Z');
    // the next poll inside the window does not call X
    advance(120_000);
    expect(await x.mentions!('1')).toEqual({ posts: [], newestId: null });
    expect(http.calls).toHaveLength(1);
    expect(x.lastError).toBe('x.mentions: rate limited until 2026-10-19T10:05:00.000Z');
    // after the reset it polls again
    limited = false;
    advance(181_000);
    expect((await x.mentions!('1')).posts).toHaveLength(4);
    expect(http.calls).toHaveLength(3);
  });

  it('429 on a later page: returns what it has, newestId null so the unread pages are read next time', async () => {
    const { x } = setup(BOT, [
      mentionsRoute({
        first: fixture('x-mentions-page1.json'),
        '7140dibdnow9c7btw4b0u5ak2r4ptq': () => ({ status: 429, text: '', headers: { 'x-rate-limit-reset': String(Math.floor(NOW / 1000) + 60) } }),
      }),
    ]);
    const res = await x.mentions!('1');
    expect(res.posts.map(p => p.id)).toEqual(['1847000000000000200', '1847000000000000300']);
    expect(res.newestId).toBeNull();
    expect(x.lastError).toBe('x.mentions: rate limited until 2026-10-19T10:01:00.000Z');
  });

  it('HTTP and shape errors → empty with lastError, never a throw', async () => {
    const down = setup(BOT, [() => ({ status: 503, json: { title: 'Service Unavailable', detail: 'Service Unavailable', status: 503 } })]);
    expect(await down.x.mentions!('1')).toEqual({ posts: [], newestId: null });
    expect(down.x.lastError).toBe('x.mentions: HTTP 503 from api.x.com: Service Unavailable');

    const unauthorized = setup(BOT, [() => ({ status: 401, json: { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' } })]);
    expect((await unauthorized.x.mentions!('1')).posts).toEqual([]);
    expect(unauthorized.x.lastError).toBe('x.mentions: HTTP 401 from api.x.com: Unauthorized');

    const errorsOnly = setup(BOT, [() => ({ json: { errors: [{ title: 'Forbidden', detail: 'User has been suspended: [1800000000000000000].' }] } })]);
    expect((await errorsOnly.x.mentions!('1')).posts).toEqual([]);
    expect(errorsOnly.x.lastError).toBe('x.mentions: User has been suspended: [1800000000000000000].');

    const garbage = setup(BOT, [() => ({ text: '<html>' })]);
    expect((await garbage.x.mentions!('1')).posts).toEqual([]);
    expect(garbage.x.lastError).toBe('x.mentions: bad JSON from api.x.com');

    const badSince = setup(BOT, []);
    expect((await badSince.x.mentions!('1 OR 1=1')).posts).toEqual([]);
    expect(badSince.http.calls).toHaveLength(0);
  });

  it('an odd optional field keeps the post; a post without text is skipped and reported', async () => {
    const { x } = setup(BOT, [
      mentionsRoute({
        first: {
          data: [
            { id: '1847000000000000002', text: '@ApeCheckBot hi', author_id: '1700000000000000003', display_text_range: 'weird', in_reply_to_user_id: 5 },
            { id: '1847000000000000001', author_id: '1700000000000000003' },
          ],
          meta: { result_count: 2, newest_id: '1847000000000000002' },
        },
      }),
    ]);
    const res = await x.mentions!('1');
    expect(res.posts.map(p => [p.id, p.displayTextRange, p.inReplyToUserId])).toEqual([['1847000000000000002', null, null]]);
    expect(res.newestId).toBe('1847000000000000002');
    expect(x.lastError).toBe('x.mentions: 1 post(s) with an unexpected shape were skipped');
  });

  it('falls back to the Bearer token when only X_BEARER_TOKEN is set', async () => {
    const { x, http } = setup({ X_BEARER_TOKEN: 'bearer-abc', X_BOT_USER_ID: BOT_ID }, [twoPages()]);
    expect(x.canPost).toBe(false);
    expect((await x.mentions!('1')).posts).toHaveLength(4);
    expect(http.calls.every(c => c.req.headers?.authorization === 'Bearer bearer-abc')).toBe(true);
    expect(await x.reply!('1847000000000000300', 'hi')).toBeNull();
    expect(http.calls).toHaveLength(2);
  });

  it('without X_BOT_USER_ID the bot id is looked up once (users/me with the user keys)', async () => {
    const { x, http } = setup(USER_KEYS, [
      url => (url.pathname === '/2/users/me' ? { json: { data: { id: BOT_ID, name: 'ApeCheck', username: 'ApeCheckBot' } } } : undefined),
      twoPages(),
    ]);
    await x.mentions!('1');
    await x.mentions!('1');
    expect(http.calls.map(path)).toEqual([
      'GET /2/users/me',
      `GET /2/users/${BOT_ID}/mentions`,
      `GET /2/users/${BOT_ID}/mentions`,
      `GET /2/users/${BOT_ID}/mentions`,
      `GET /2/users/${BOT_ID}/mentions`,
    ]);
    expectSigned(http.calls[0]);
  });

  it('without X_BOT_USER_ID and only a Bearer token, the id comes from X_BOT_HANDLE; a failed lookup is retried', async () => {
    let fail = true;
    const { x, http } = setup({ X_BEARER_TOKEN: 'bearer-abc', X_BOT_HANDLE: 'ApeCheckBot' }, [
      url => (url.pathname === '/2/users/by/username/ApeCheckBot'
        ? fail ? { status: 503, text: '' } : { json: { data: { id: BOT_ID, username: 'ApeCheckBot', name: 'ApeCheck' } } }
        : undefined),
      twoPages(),
    ]);
    expect(await x.mentions!('1')).toEqual({ posts: [], newestId: null });
    expect(x.lastError).toBe('x.getUser: HTTP 503 from api.x.com');
    fail = false;
    expect((await x.mentions!('1')).posts).toHaveLength(4);
    expect(http.calls.map(path)).toEqual([
      'GET /2/users/by/username/ApeCheckBot',
      'GET /2/users/by/username/ApeCheckBot',
      `GET /2/users/${BOT_ID}/mentions`,
      `GET /2/users/${BOT_ID}/mentions`,
    ]);
  });

  it('a non-numeric X_BOT_USER_ID is refused without a request', async () => {
    const { x, http } = setup({ ...USER_KEYS, X_BOT_USER_ID: '@ApeCheckBot' }, []);
    expect(await x.mentions!('1')).toEqual({ posts: [], newestId: null });
    expect(x.lastError).toBe('x.mentions: X_BOT_USER_ID must be the numeric user id of the bot account');
    expect(http.calls).toHaveLength(0);
  });
});

/* ---------------- reply + media ---------------- */

/** a fake 2.5 MB "PNG": 3 chunks of ≤ 1 MB */
function fakePng(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
}

function parseMultipart(body: Buffer, contentType: string) {
  const boundary = /^multipart\/form-data; boundary=(\S+)$/.exec(contentType)![1];
  const delim = Buffer.from(`--${boundary}`);
  expect(body.subarray(body.length - delim.length - 4).toString()).toBe(`--${boundary}--\r\n`);
  const parts: { name: string; headers: string; data: Buffer }[] = [];
  let at = body.indexOf(delim);
  while (at !== -1) {
    const start = at + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delim, start);
    const part = body.subarray(start + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, headEnd).toString();
    parts.push({ name: /name="([^"]+)"/.exec(headers)![1], headers, data: part.subarray(headEnd + 4) });
    at = next;
  }
  return parts;
}

interface MediaScript {
  init?: () => { status?: number; json?: unknown };
  finalize?: unknown;
  statuses?: unknown[];
  tweet?: () => { status?: number; json?: unknown; headers?: Record<string, string> };
}
function xWrite(script: MediaScript = {}): Handler {
  const statuses = [...(script.statuses ?? [])];
  return (url, req) => {
    const p = url.pathname;
    if (p === '/2/media/upload/initialize' && req.method === 'POST') {
      return script.init?.() ?? { json: { data: { id: MEDIA_ID, media_key: `3_${MEDIA_ID}`, expires_after_secs: 86400 } } };
    }
    if (p === `/2/media/upload/${MEDIA_ID}/append` && req.method === 'POST') return { status: 200, text: '' };
    if (p === `/2/media/upload/${MEDIA_ID}/finalize` && req.method === 'POST') {
      return { json: script.finalize ?? { data: { id: MEDIA_ID, media_key: `3_${MEDIA_ID}`, size: 2621440, expires_after_secs: 86400 } } };
    }
    if (p === '/2/media/upload' && req.method === 'GET') return { json: statuses.shift() };
    if (p === '/2/tweets' && req.method === 'POST') {
      return script.tweet?.() ?? { status: 201, json: { data: { id: '1847000000000000999', text: 'x', edit_history_tweet_ids: ['1847000000000000999'] } } };
    }
    return undefined;
  };
}

const TEXT = "LIKELY LARP (37/100) · Coin: SKETCHY (37)\n'Launch app' does nothing; GitHub pushed in one burst at launch.\nChecks the claims, not the team. DYOR.";

describe('X bot: reply()', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uploads the card (initialize → append ×3 → finalize → STATUS polls) then posts the reply with it', async () => {
    const png = fakePng(2.5 * 1024 * 1024);
    const { x, http, sleeps } = setup(BOT, [
      xWrite({
        finalize: { data: { id: MEDIA_ID, media_key: `3_${MEDIA_ID}`, processing_info: { state: 'pending', check_after_secs: 2 } } },
        statuses: [
          { data: { id: MEDIA_ID, processing_info: { state: 'in_progress', check_after_secs: 1, progress_percent: 60 } } },
          { data: { id: MEDIA_ID, processing_info: { state: 'succeeded', progress_percent: 100 } } },
        ],
      }),
    ]);
    const id = await x.reply!('1847000000000000300', TEXT, png);
    expect(id).toBe('1847000000000000999');
    expect(x.lastError).toBeNull();
    expect(http.calls.map(path)).toEqual([
      'POST /2/media/upload/initialize',
      `POST /2/media/upload/${MEDIA_ID}/append`,
      `POST /2/media/upload/${MEDIA_ID}/append`,
      `POST /2/media/upload/${MEDIA_ID}/append`,
      `POST /2/media/upload/${MEDIA_ID}/finalize`,
      'GET /2/media/upload',
      'GET /2/media/upload',
      'POST /2/tweets',
    ]);
    // every call is OAuth 1.0a signed over the query + oauth_* params only
    http.calls.forEach(expectSigned);
    const nonces = http.calls.map(c => parseOAuthHeader(c.req.headers!.authorization).oauth_nonce);
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(sleeps).toEqual([2000, 1000]);
    // the STATUS polls are signed after the waits
    expect(parseOAuthHeader(http.calls[6].req.headers!.authorization).oauth_timestamp).toBe(String(Math.floor(NOW / 1000) + 3));

    const [init, a0, a1, a2, fin, st] = http.calls;
    expect(init.req.headers?.['content-type']).toBe('application/json');
    expect(init.body).toEqual({ media_type: 'image/png', total_bytes: png.length, media_category: 'tweet_image' });

    const chunks = [a0, a1, a2].map((c, i) => {
      expect(Buffer.isBuffer(c.req.body)).toBe(true);
      const parts = parseMultipart(c.req.body as Buffer, c.req.headers!['content-type']);
      expect(parts.map(pt => pt.name)).toEqual(['segment_index', 'media']);
      expect(parts[0].data.toString()).toBe(String(i));
      expect(parts[0].headers).toBe('Content-Disposition: form-data; name="segment_index"');
      expect(parts[1].headers).toBe('Content-Disposition: form-data; name="media"; filename="blob"\r\nContent-Type: application/octet-stream');
      expect(parts[1].data.length).toBeLessThanOrEqual(MEDIA_CHUNK_BYTES);
      return parts[1].data;
    });
    expect(chunks.map(c => c.length)).toEqual([MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES, png.length - 2 * MEDIA_CHUNK_BYTES]);
    expect(Buffer.concat(chunks).equals(png)).toBe(true);

    expect(fin.req.body).toBeUndefined();
    const su = new URL(st.url);
    expect(su.searchParams.get('command')).toBe('STATUS');
    expect(su.searchParams.get('media_id')).toBe(MEDIA_ID);

    const tweet = http.calls.at(-1)!;
    expect(tweet.req.headers?.['content-type']).toBe('application/json');
    expect(tweet.body).toEqual({ text: TEXT, reply: { in_reply_to_tweet_id: '1847000000000000300' }, media: { media_ids: [MEDIA_ID] } });
  });

  it('a small card is one append and no STATUS poll when finalize has no processing_info', async () => {
    const { x, http, sleeps } = setup(BOT, [xWrite()]);
    expect(await x.reply!('1847000000000000300', TEXT, fakePng(180_000))).toBe('1847000000000000999');
    expect(http.calls.map(path)).toEqual([
      'POST /2/media/upload/initialize',
      `POST /2/media/upload/${MEDIA_ID}/append`,
      `POST /2/media/upload/${MEDIA_ID}/finalize`,
      'POST /2/tweets',
    ]);
    expect(sleeps).toEqual([]);
  });

  it('without media: one signed POST /2/tweets', async () => {
    const { x, http } = setup(BOT, [xWrite()]);
    expect(await x.reply!('1847000000000000300', 'Tag me under a project’s post, or include its link or contract.')).toBe('1847000000000000999');
    expect(http.calls.map(path)).toEqual(['POST /2/tweets']);
    expectSigned(http.calls[0]);
    expect(http.calls[0].body).toEqual({
      text: 'Tag me under a project’s post, or include its link or contract.',
      reply: { in_reply_to_tweet_id: '1847000000000000300' },
    });
    // an empty buffer counts as no media
    expect(await x.reply!('1847000000000000300', 'again', Buffer.alloc(0))).toBe('1847000000000000999');
    expect(http.calls).toHaveLength(2);
  });

  it('media upload failure → the text reply goes out without the card (logged)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { x, http } = setup(BOT, [xWrite({ init: () => ({ status: 400, json: { title: 'Invalid Request', detail: 'One or more parameters to your request was invalid.' } }) })]);
    expect(await x.reply!('1847000000000000300', TEXT, fakePng(5000))).toBe('1847000000000000999');
    expect(http.calls.map(path)).toEqual(['POST /2/media/upload/initialize', 'POST /2/tweets']);
    expect(http.calls[1].body).toEqual({ text: TEXT, reply: { in_reply_to_tweet_id: '1847000000000000300' } });
    expect(x.lastError).toBe('x.uploadMedia: HTTP 400 from api.x.com: One or more parameters to your request was invalid.');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[apecheck\] WARN x\.reply: card upload failed \(HTTP 400 .*\); replying to 1847000000000000300 without it$/));
  });

  it('media processing failed / never finishing → text-only reply, bounded polling', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = setup(BOT, [
      xWrite({
        finalize: { data: { id: MEDIA_ID, processing_info: { state: 'pending', check_after_secs: 1 } } },
        statuses: [{ data: { id: MEDIA_ID, processing_info: { state: 'failed', error: { code: 1, name: 'InvalidMedia', message: 'Unsupported image format' } } } }],
      }),
    ]);
    expect(await failed.x.reply!('1847000000000000300', TEXT, fakePng(5000))).toBe('1847000000000000999');
    expect(failed.x.lastError).toBe('x.uploadMedia: media processing failed: Unsupported image format');
    expect(failed.http.calls.at(-1)!.body).not.toHaveProperty('media');

    const stuck = { data: { id: MEDIA_ID, processing_info: { state: 'in_progress', check_after_secs: 600 } } };
    const slow = setup(BOT, [xWrite({ finalize: stuck, statuses: Array(50).fill(stuck) })]);
    expect(await slow.x.reply!('1847000000000000300', TEXT, fakePng(5000))).toBe('1847000000000000999');
    expect(slow.x.lastError).toBe('x.uploadMedia: media processing did not finish in time');
    // check_after_secs is clamped to 10 s and the total wait to 60 s
    expect(slow.sleeps.every(ms => ms === 10_000)).toBe(true);
    expect(slow.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
  });

  it('exclude_reply_user_ids: X’s auto-filled reply mentions are taken out, numeric ids once each, never the bot', async () => {
    const { x, http } = setup(BOT, [xWrite()]);
    const ids = ['1500000000000000001', '1900000000000000002', BOT_ID, '1500000000000000001', '@evil', '', 'abc', '1900000000000000003'];
    expect(await x.reply!('1847000000000000300', TEXT, fakePng(5000), { excludeUserIds: ids })).toBe('1847000000000000999');
    expect(http.calls.at(-1)!.body).toEqual({
      text: TEXT,
      reply: { in_reply_to_tweet_id: '1847000000000000300', exclude_reply_user_ids: ['1500000000000000001', '1900000000000000002', '1900000000000000003'] },
      media: { media_ids: [MEDIA_ID] },
    });
    expectSigned(http.calls.at(-1)!);
    // nothing to leave out (or only the bot / junk): no exclude_reply_user_ids key at all
    for (const excludeUserIds of [[], [BOT_ID], ['x'], null, undefined]) {
      expect(await x.reply!('1847000000000000300', `t ${String(excludeUserIds)}`, null, { excludeUserIds })).toBe('1847000000000000999');
      expect(http.calls.at(-1)!.body).toEqual({ text: `t ${String(excludeUserIds)}`, reply: { in_reply_to_tweet_id: '1847000000000000300' } });
    }
  });

  it('a mention naming many accounts: the reply leaves out every one of them but its author (mentions() → reply())', async () => {
    const tagged = Array.from({ length: 40 }, (_, i) => ({ username: `v${i + 1}`, id: String(1900000000000000100n + BigInt(i)) }));
    const text = `@ApeCheckBot evil.xyz ${tagged.map(t => `@${t.username}`).join(' ')}`;
    const { x, http } = setup(BOT, [
      mentionsRoute({
        first: {
          data: [{
            id: '1847000000000000500',
            text,
            author_id: '1700000000000000003',
            entities: { mentions: [{ username: 'ApeCheckBot', id: BOT_ID }, ...tagged, { username: 'oldwhale', id: '1700000000000000003' }] },
          }],
          meta: { result_count: 1, newest_id: '1847000000000000500' },
        },
      }),
      xWrite(),
    ]);
    const [m] = (await x.mentions!('1')).posts;
    // what worker-bot stores and passes: every mentioned account but the asker
    const excludeUserIds = m.mentionUserIds!.filter(id => id !== m.authorId);
    expect(await x.reply!(m.id, TEXT, null, { excludeUserIds })).toBe('1847000000000000999');
    const body = http.calls.at(-1)!.body as { reply: { in_reply_to_tweet_id: string; exclude_reply_user_ids: string[] } };
    expect(body.reply.in_reply_to_tweet_id).toBe(m.id);
    expect(body.reply.exclude_reply_user_ids).toEqual(tagged.map(t => t.id));
    expect(body.reply.exclude_reply_user_ids).not.toContain(m.authorId);
    expect(body.reply.exclude_reply_user_ids).not.toContain(BOT_ID);
  });

  it(`more than ${X_REPLY_EXCLUDE_MAX} accounts to leave out: nothing is posted (no request, no upload)`, async () => {
    const { x, http } = setup(BOT, [xWrite()]);
    const ids = Array.from({ length: X_REPLY_EXCLUDE_MAX + 1 }, (_, i) => String(1900000000000000000n + BigInt(i)));
    expect(await x.reply!('1847000000000000300', TEXT, fakePng(5000), { excludeUserIds: ids })).toBeNull();
    expect(x.lastError).toBe(`x.reply: not posted: more than ${X_REPLY_EXCLUDE_MAX} accounts to leave out of the reply`);
    expect(http.calls).toHaveLength(0);
    // exactly the maximum goes out
    expect(await x.reply!('1847000000000000300', TEXT, null, { excludeUserIds: ids.slice(1) })).toBe('1847000000000000999');
    expect((http.calls[0].body as { reply: { exclude_reply_user_ids: string[] } }).reply.exclude_reply_user_ids).toHaveLength(X_REPLY_EXCLUDE_MAX);
  });

  it('without X_BOT_USER_ID the looked-up bot id is dropped from the exclusions too', async () => {
    const { x, http } = setup(USER_KEYS, [
      url => (url.pathname === '/2/users/me' ? { json: { data: { id: BOT_ID, name: 'ApeCheck', username: 'ApeCheckBot' } } } : undefined),
      mentionsRoute({ first: { meta: { result_count: 0 } } }),
      xWrite(),
    ]);
    await x.mentions!('1');
    expect(await x.reply!('1847000000000000300', TEXT, null, { excludeUserIds: [BOT_ID, '1500000000000000001'] })).toBe('1847000000000000999');
    expect(http.calls.at(-1)!.body).toEqual({ text: TEXT, reply: { in_reply_to_tweet_id: '1847000000000000300', exclude_reply_user_ids: ['1500000000000000001'] } });
  });

  it('403 duplicate content → null with lastError', async () => {
    const { x } = setup(BOT, [
      xWrite({ tweet: () => ({ status: 403, json: { detail: 'You are not allowed to create a Tweet with duplicate content.', type: 'about:blank', title: 'Forbidden', status: 403 } }) }),
    ]);
    expect(await x.reply!('1847000000000000300', TEXT)).toBeNull();
    expect(x.lastError).toBe('x.reply: duplicate content (HTTP 403)');
  });

  it('other 403s (reply restrictions) keep X’s reason', async () => {
    const detail = 'Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author of the post you are replying to.';
    const { x } = setup(BOT, [xWrite({ tweet: () => ({ status: 403, json: { detail, title: 'Forbidden', status: 403 } }) })]);
    expect(await x.reply!('1847000000000000300', TEXT)).toBeNull();
    expect(x.lastError).toBe(`x.reply: HTTP 403 from api.x.com: ${detail}`);
  });

  it('429 → null; later replies inside the window are refused without a request (24-hour cap honoured)', async () => {
    const userReset = Math.floor(NOW / 1000) + 3 * 3600;
    const { x, http, advance } = setup(BOT, [
      xWrite({
        tweet: () => ({
          status: 429,
          json: { title: 'Too Many Requests', status: 429 },
          headers: {
            'x-rate-limit-remaining': '150', 'x-rate-limit-reset': String(Math.floor(NOW / 1000) + 600),
            'x-user-limit-24hour-remaining': '0', 'x-user-limit-24hour-reset': String(userReset),
          },
        }),
      }),
    ]);
    expect(await x.reply!('1847000000000000300', TEXT)).toBeNull();
    expect(x.lastError).toBe('x.reply: rate limited until 2026-10-19T13:00:00.000Z');
    advance(3600_000);
    expect(await x.reply!('1847000000000000300', TEXT, fakePng(100))).toBeNull();
    expect(http.calls).toHaveLength(1);
    expect(x.lastError).toBe('x.reply: rate limited until 2026-10-19T13:00:00.000Z');
  });

  it('5xx → null with lastError (the caller marks the mention FAILED and may retry)', async () => {
    const { x } = setup(BOT, [xWrite({ tweet: () => ({ status: 503, json: { title: 'Service Unavailable' } }) })]);
    expect(await x.reply!('1847000000000000300', TEXT)).toBeNull();
    expect(x.lastError).toBe('x.reply: HTTP 503 from api.x.com: Service Unavailable');
  });

  it('bad input is refused without a request', async () => {
    const { x, http } = setup(BOT, [xWrite()]);
    expect(await x.reply!('https://x.com/a/status/1', TEXT)).toBeNull();
    expect(x.lastError).toMatch(/^x\.reply: invalid post id/);
    expect(await x.reply!('1847000000000000300', '   ')).toBeNull();
    expect(x.lastError).toBe('x.reply: empty text');
    expect(http.calls).toHaveLength(0);
  });

  it('stub without all four user keys: null, no request', async () => {
    const { x, http } = setup({ X_API_KEY: 'a', X_API_SECRET: 'b', X_ACCESS_TOKEN: 'c', X_BOT_USER_ID: BOT_ID }, [xWrite()]);
    expect(x.canPost).toBe(false);
    expect(await x.reply!('1847000000000000300', TEXT, fakePng(100))).toBeNull();
    expect(await x.mentions!('1')).toEqual({ posts: [], newestId: null });
    expect(http.calls).toHaveLength(0);
  });
});

describe('X bot: createSources().x', () => {
  it('is the full adapter: mentions() and reply() typed as present, signed over the injected Http', async () => {
    const http = fakeHttp(mentionsRoute({ first: { meta: { result_count: 0 } } }), xWrite());
    const started = Date.now();
    const sources = createSources(testEnv(BOT), { http });
    // XBotSource: no "!" needed, the methods are part of the returned type
    const x: XBotSource = sources.x;
    expect(x.canPost).toBe(true);
    expect(await x.mentions('1846800000000000001')).toEqual({ posts: [], newestId: null });
    expect(await x.reply('1847000000000000300', TEXT, fakePng(5000))).toBe('1847000000000000999');
    expect(http.calls.map(path)).toEqual([
      `GET /2/users/${BOT_ID}/mentions`,
      'POST /2/media/upload/initialize',
      `POST /2/media/upload/${MEDIA_ID}/append`,
      `POST /2/media/upload/${MEDIA_ID}/finalize`,
      'POST /2/tweets',
    ]);
    // the real clock: createSources() takes no test hooks
    for (const call of http.calls) expectSignedSince(call, started);
    expect(http.calls.at(-1)!.body).toEqual({ text: TEXT, reply: { in_reply_to_tweet_id: '1847000000000000300' }, media: { media_ids: [MEDIA_ID] } });
  });

  it('without the user keys the methods still exist and do nothing (worker-bot idles)', async () => {
    const http = fakeHttp();
    const x = createSources(testEnv({ X_BEARER_TOKEN: '' }), { http }).x;
    expect(x.canPost).toBe(false);
    expect(await x.mentions(null)).toEqual({ posts: [], newestId: null });
    expect(await x.reply('1847000000000000300', 'hi')).toBeNull();
    expect(http.calls).toHaveLength(0);
  });
});

describe('X bot: helpers', () => {
  it('multipartBody builds CRLF-delimited parts with a closing boundary', () => {
    const { body, contentType } = multipartBody([['segment_index', '0'], ['media', Buffer.from([1, 2, 3])]], 'BOUNDARY');
    expect(contentType).toBe('multipart/form-data; boundary=BOUNDARY');
    expect(body.equals(Buffer.concat([
      Buffer.from('--BOUNDARY\r\nContent-Disposition: form-data; name="segment_index"\r\n\r\n0\r\n'),
      Buffer.from('--BOUNDARY\r\nContent-Disposition: form-data; name="media"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n'),
      Buffer.from([1, 2, 3]),
      Buffer.from('\r\n--BOUNDARY--\r\n'),
    ]))).toBe(true);
    expect(multipartBody([['a', 'b']]).contentType).toMatch(/^multipart\/form-data; boundary=ApeCheck[0-9a-f]{24}$/);
  });

  it('rateLimitUntil: latest exhausted window, else x-rate-limit-reset, else 60 s', () => {
    const now = NOW;
    const s = (n: number) => String(Math.floor(now / 1000) + n);
    expect(rateLimitUntil({ 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': s(900) }, now)).toBe((Math.floor(now / 1000) + 900) * 1000);
    expect(rateLimitUntil({ 'x-rate-limit-reset': s(30) }, now)).toBe((Math.floor(now / 1000) + 30) * 1000);
    expect(
      rateLimitUntil({ 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': s(900), 'x-app-limit-24hour-remaining': '0', 'x-app-limit-24hour-reset': s(7200) }, now),
    ).toBe((Math.floor(now / 1000) + 7200) * 1000);
    expect(rateLimitUntil({}, now)).toBe(now + 60_000);
    expect(rateLimitUntil({ 'x-rate-limit-reset': '1760054400' }, now)).toBe(now + 60_000); // already past
  });
});
