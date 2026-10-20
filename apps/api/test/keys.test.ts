/** M4 API keys: management (session + Max), show-once, hash at rest, key auth on the developer routes, limits, credits. */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  creditsKeyUser,
  type ApiKeyDTO,
  type CreateApiKeyResponse,
  type CreateCheckResponse,
  type MeDTO,
} from '@apecheck/core';
import { TIER_CACHE_MS } from '@apecheck/db';
import { Client, EvmWallet, SolWallet, makeHarness, parseSse, resetState, seedCheck, seedTarget, signedIn, type Harness } from './helpers';

const maxW = new EvmWallet();
const max2W = new SolWallet();
const proW = new EvmWallet();
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function maxClient(h: Harness, w: EvmWallet | SolWallet = maxW) {
  const c = new Client(h.app);
  const me = await signedIn(c, w);
  return { c, me, userId: me.user!.id };
}

async function newKey(c: Client, name?: string): Promise<CreateApiKeyResponse> {
  const res = await c.post('/v1/keys', name === undefined ? {} : { name });
  if (res.statusCode !== 201) throw new Error(`create key ${res.statusCode}: ${res.body}`);
  return res.json<CreateApiKeyResponse>();
}

describe('API key management', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ TIER_OVERRIDES: `${maxW.address}:max,${max2W.address}:max,${proW.address}:pro`, API_KEYS_PER_USER: '3' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => resetState(h));

  it('needs a signed-in Max user: 401 signed out, 403 max_required for Free and Pro', async () => {
    const anon = new Client(h.app);
    for (const res of [await anon.get('/v1/keys'), await anon.post('/v1/keys', {})]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'sign_in_required', error: 'Sign in with a wallet to manage API keys and webhooks.' });
    }
    const free = new Client(h.app);
    await signedIn(free, new EvmWallet());
    const pro = new Client(h.app);
    await signedIn(pro, proW);
    for (const c of [free, pro]) {
      for (const res of [await c.get('/v1/keys'), await c.post('/v1/keys', {})]) {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ code: 'max_required', error: 'API keys, webhooks and MCP need Max. Pro and Max open at token launch.' });
      }
    }
    expect(await h.prisma.apiKey.count()).toBe(0);
  });

  it('creates a key shown once; the list never shows it again', async () => {
    const { c, userId } = await maxClient(h);
    const res = await c.post('/v1/keys', { name: '  trading   bot \u0007 ' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const created = res.json<CreateApiKeyResponse>();
    expect(created).toEqual({
      id: expect.any(String),
      name: 'trading bot',
      prefix: created.key.slice(0, 12),
      createdAt: expect.any(String),
      lastUsedAt: null,
      key: expect.stringMatching(/^ak_live_[A-Za-z0-9]{32}$/),
    });
    expect(created.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(created.prefix).toMatch(/^ak_live_[A-Za-z0-9]{4}$/);

    const second = await newKey(c);
    expect(second.name).toBe('API key');
    expect(second.key).not.toBe(created.key);

    const list = await c.get('/v1/keys');
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const items = list.json<{ items: ApiKeyDTO[] }>().items;
    expect(items.map(k => k.id)).toEqual([second.id, created.id]);
    expect(items[1]).toEqual({ id: created.id, name: 'trading bot', prefix: created.prefix, createdAt: created.createdAt, lastUsedAt: null });
    expect(list.body).not.toContain(created.key);
    expect(list.body).not.toContain(second.key);
    expect(await h.prisma.apiKey.count({ where: { userId } })).toBe(2);
  });

  it('stores only the sha256 of the key: the plaintext is nowhere in the database or Redis', async () => {
    const { c } = await maxClient(h);
    const { key, id } = await newKey(c, 'secret test');
    // use it once, so every write path a request takes (lastUsedAt, rate limits, credits) has run
    expect((await c.get('/v1/me', bearer(key))).statusCode).toBe(200);
    expect((await new Client(h.app).post('/v1/checks', { target: 'usedkey.xyz' }, bearer(key))).statusCode).toBe(201);

    const row = await h.prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(row.hash).toBe(sha256(key));
    expect(row.prefix).toBe(key.slice(0, 12));

    const secretPart = key.slice(API_KEY_PREFIX.length);
    const cols = await h.prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`;
    expect(cols.length).toBeGreaterThan(10);
    for (const { table_name, column_name } of cols) {
      const hits = await h.prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT COUNT(*)::int AS n FROM "${table_name}" WHERE "${column_name}"::text LIKE $1`,
        `%${secretPart}%`,
      );
      expect(hits[0].n, `${table_name}.${column_name}`).toBe(0);
    }
    for (const k of await h.redis.keys('*')) {
      expect(k).not.toContain(secretPart);
      const type = await h.redis.type(k);
      const value =
        type === 'string' ? await h.redis.get(k) : type === 'hash' ? JSON.stringify(await h.redis.hgetall(k)) : type === 'zset' ? JSON.stringify(await h.redis.zrange(k, 0, -1)) : type === 'list' ? JSON.stringify(await h.redis.lrange(k, 0, -1)) : '';
      expect(value ?? '').not.toContain(secretPart);
    }
  });

  it('API_KEYS_PER_USER active keys at most (409 too_many_keys); a revoked key frees a slot; concurrent creates hold the limit', async () => {
    const { c, userId } = await maxClient(h);
    const a = await newKey(c);
    await Promise.all([newKey(c), newKey(c)]);
    const over = await c.post('/v1/keys', {});
    expect(over.statusCode).toBe(409);
    expect(over.json()).toEqual({ code: 'too_many_keys', error: 'You have 3 API keys, the most allowed. Revoke one to create another.' });
    expect((await c.delete(`/v1/keys/${a.id}`)).json()).toEqual({ ok: true });
    expect((await c.post('/v1/keys', {})).statusCode).toBe(201);

    // another user starts empty; two creates at once with one slot left: one wins
    const other = await maxClient(h, max2W);
    await newKey(other.c);
    await newKey(other.c);
    const both = await Promise.all([other.c.post('/v1/keys', {}), other.c.post('/v1/keys', {})]);
    expect(both.map(r => r.statusCode).sort()).toEqual([201, 409]);
    expect(await h.prisma.apiKey.count({ where: { userId: other.userId, revokedAt: null } })).toBe(3);
    expect(await h.prisma.apiKey.count({ where: { userId, revokedAt: null } })).toBe(3);
  });

  it('400 for a name over 40 characters or not a string', async () => {
    const { c } = await maxClient(h);
    for (const name of ['x'.repeat(41), 42]) {
      const res = await c.post('/v1/keys', { name });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ code: 'bad_request', error: 'Give the key a name of up to 40 characters.' });
    }
    expect((await c.post('/v1/keys', { name: 'x'.repeat(40) })).statusCode).toBe(201);
  });

  it('revokes: the key stops working at once, the list drops it, a repeat is fine, others get 404', async () => {
    const { c } = await maxClient(h);
    const k = await newKey(c);
    expect((await new Client(h.app).get('/v1/me', bearer(k.key))).statusCode).toBe(200);
    expect((await c.delete(`/v1/keys/${k.id}`)).json()).toEqual({ ok: true });
    const res = await new Client(h.app).get('/v1/me', bearer(k.key));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'invalid_key', error: "This API key isn't valid or was revoked. Create a new one on apecheck.io/api." });
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
    expect((await c.get('/v1/keys')).json<{ items: ApiKeyDTO[] }>().items).toEqual([]);
    expect((await c.delete(`/v1/keys/${k.id}`)).statusCode).toBe(200);
    expect((await h.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } })).revokedAt).toBeInstanceOf(Date);

    const other = await maxClient(h, max2W);
    const theirs = await newKey(other.c);
    for (const id of [theirs.id, 'cl0000000000000000000000', 'nope']) {
      const r = await c.delete(`/v1/keys/${id}`);
      expect(r.statusCode).toBe(404);
      expect(r.json().code).toBe('not_found');
    }
    expect((await new Client(h.app).get('/v1/me', bearer(theirs.key))).statusCode).toBe(200);
  });

  it("a key never manages keys or webhooks, nor the wallet session (403), even next to a session cookie", async () => {
    const { c } = await maxClient(h);
    const k = await newKey(c);
    const hook = await h.prisma.webhook.create({ data: { userId: (await h.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } })).userId, url: 'https://93.184.215.14/x', secret: 'whsec_x', events: ['check.completed'] } });
    const bare = new Client(h.app);
    const calls: [string, string, unknown?][] = [
      ['GET', '/v1/keys'],
      ['POST', '/v1/keys', {}],
      ['DELETE', `/v1/keys/${k.id}`],
      ['GET', '/v1/webhooks'],
      ['POST', '/v1/webhooks', { url: 'https://93.184.215.14/y', events: ['check.completed'] }],
      ['DELETE', `/v1/webhooks/${hook.id}`],
      ['POST', `/v1/webhooks/${hook.id}/enable`],
      ['POST', `/v1/webhooks/${hook.id}/test`],
      ['GET', `/v1/webhooks/${hook.id}/deliveries`],
      ['POST', '/v1/auth/logout'],
      ['GET', '/v1/auth/x/start'],
    ];
    for (const client of [bare, c]) {
      for (const [method, url, payload] of calls) {
        const res = await client.req({ method: method as 'GET', url, payload: payload as object | undefined, headers: bearer(k.key) });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toEqual({ code: 'forbidden', error: "API keys can't manage keys or webhooks. Sign in on apecheck.io/api to do that." });
      }
    }
    expect(await h.prisma.apiKey.count({ where: { revokedAt: null } })).toBe(1);
    expect(await h.prisma.webhook.count()).toBe(1);
    // the session still works for management on its own
    expect((await c.get('/v1/keys')).statusCode).toBe(200);
  });

  it('a signed-in user who is no longer Max can still revoke their keys', async () => {
    const { c, userId } = await maxClient(h);
    const k = await newKey(c);
    // a Free user can't create or list, but an old key of theirs can be revoked
    const free = new Client(h.app);
    const freeMe = await signedIn(free, new EvmWallet());
    const row = await h.prisma.apiKey.update({ where: { id: k.id }, data: { userId: freeMe.user!.id } });
    expect((await free.get('/v1/keys')).statusCode).toBe(403);
    expect((await free.delete(`/v1/keys/${row.id}`)).json()).toEqual({ ok: true });
    expect(await h.prisma.apiKey.count({ where: { userId, revokedAt: null } })).toBe(0);
  });
});

describe('API key auth on the developer routes', () => {
  let h: Harness;
  let key: string;
  let keyId: string;
  let userId: string;
  beforeAll(async () => {
    h = await makeHarness({ TIER_OVERRIDES: `${maxW.address}:max,${max2W.address}:max` });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await resetState(h);
    const m = await maxClient(h);
    userId = m.userId;
    const k = await newKey(m.c, 'ci');
    key = k.key;
    keyId = k.id;
  });

  it('every developer route works with the key, as its owner, and refuses a bad key with 401 invalid_key', async () => {
    const t = await seedTarget(h.prisma);
    const done = await seedCheck(h.prisma, { targetId: t.id });
    const running = await seedCheck(h.prisma, { targetId: t.id, status: 'RUNNING' });
    const routes: [string, string, unknown?][] = [
      ['GET', `/v1/checks/${done.shortId}`],
      ['GET', `/v1/checks/${done.shortId}/events`],
      ['GET', '/v1/feed'],
      ['GET', '/v1/live'],
      ['GET', '/v1/coins'],
      ['GET', '/v1/deployers'],
      ['GET', '/v1/insights'],
      ['GET', '/v1/me'],
      ['POST', `/v1/watch/${t.id}`],
      ['GET', '/v1/watchlist'],
      ['GET', '/v1/notifications'],
      ['POST', '/v1/checks', { target: 'keyed-site.xyz' }],
    ];
    const bad = ['ak_live_' + 'x'.repeat(32), 'ak_live_short', 'sk_live_' + 'a'.repeat(32), '', key + 'x'];
    for (const [method, url, payload] of routes) {
      const c = new Client(h.app);
      for (const b of bad) {
        const res = await c.req({ method: method as 'GET', url, payload: payload as object | undefined, headers: { authorization: `Bearer ${b}` } });
        expect(res.statusCode, `${method} ${url} with "${b}"`).toBe(401);
        expect(res.json().code).toBe('invalid_key');
      }
      const res = await c.req({ method: method as 'GET', url, payload: payload as object | undefined, headers: bearer(key) });
      expect(res.statusCode, `${method} ${url}`).toBeLessThan(300);
      // a server isn't a browser: no anonymous cookie for keyed requests
      expect(c.lastSetCookie).toEqual([]);
    }
    // the keyed calls acted as the owner
    expect((await new Client(h.app).get('/v1/me', bearer(key))).json<MeDTO>()).toMatchObject({ tier: 'max', user: { id: userId } });
    expect(await h.prisma.watch.count({ where: { userId } })).toBe(1);
    const check = await h.prisma.check.findFirstOrThrow({ where: { targetRaw: 'keyed-site.xyz' } });
    expect(check).toMatchObject({ via: 'API', requesterId: userId, isPrivate: false });
    // asks: past the Pro gate (the check is still running)
    const ask = await new Client(h.app).post(`/v1/checks/${running.shortId}/asks`, { question: 'who funded it?' }, bearer(key));
    expect(ask.statusCode).toBe(409);
    expect(ask.json().code).toBe('not_ready');
    // the SSE stream of a finished check replays and ends with the report
    const sse = await new Client(h.app).get(`/v1/checks/${done.shortId}/events`, bearer(key));
    expect(sse.headers['content-type']).toMatch(/text\/event-stream/);
    expect(parseSse(sse.body).at(-1)?.event).toBe('done');
  });

  it('a key acts as its owner even next to another user\'s session cookie; private checks follow the owner', async () => {
    const other = new Client(h.app);
    await signedIn(other, max2W);
    const res = await other.get('/v1/me', bearer(key));
    expect(res.json<MeDTO>().user?.id).toBe(userId);

    const priv = await new Client(h.app).post('/v1/checks', { target: 'secret-project.xyz', private: true }, bearer(key));
    expect(priv.statusCode).toBe(201);
    const id = priv.json<CreateCheckResponse>().id;
    expect((await new Client(h.app).get(`/v1/checks/${id}`, bearer(key))).statusCode).toBe(200);
    expect((await other.get(`/v1/checks/${id}`)).statusCode).toBe(404);
    expect((await new Client(h.app).get(`/v1/checks/${id}`)).statusCode).toBe(404);
  });

  it("checks through a key are charged to the owner's MAX_CHECKS_PER_DAY", async () => {
    const c = new Client(h.app, '198.51.100.7');
    const res = await c.post('/v1/checks', { target: 'credit-test.xyz' }, bearer(key));
    expect(res.statusCode).toBe(201);
    expect(res.json<CreateCheckResponse>().credits).toBe(199);
    expect(await h.redis.get(creditsKeyUser(userId))).toBe('1');
    // nothing counted per IP or cookie for a Max user
    expect((await h.redis.keys('credits:*')).sort()).toEqual([creditsKeyUser(userId)]);
    // the site shows the same balance to the signed-in owner
    const site = new Client(h.app);
    await signedIn(site, maxW);
    expect((await site.get('/v1/me')).json<MeDTO>()).toMatchObject({ credits: 199, max: 200 });
    // the job runs at Max priority
    const job = (await h.queue.getJobs(['prioritized', 'waiting']))[0];
    expect(job.opts.priority).toBe(1);
  });

  it('lastUsedAt is written on use, at most once a minute', async () => {
    expect((await h.prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } })).lastUsedAt).toBeNull();
    await new Client(h.app).get('/v1/feed', bearer(key));
    const first = (await h.prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } })).lastUsedAt!;
    expect(first.getTime()).toBeGreaterThan(Date.now() - 5000);
    await new Client(h.app).get('/v1/feed', bearer(key));
    expect((await h.prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } })).lastUsedAt!.getTime()).toBe(first.getTime());
    await h.prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date(Date.now() - 61_000) } });
    await new Client(h.app).get('/v1/feed', bearer(key));
    expect((await h.prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } })).lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('a key whose owner is not Max gets 403 max_required', async () => {
    const free = new Client(h.app);
    const me = await signedIn(free, new EvmWallet());
    const plain = 'ak_live_' + 'F'.repeat(32);
    await h.prisma.apiKey.create({ data: { userId: me.user!.id, prefix: plain.slice(0, 12), hash: sha256(plain) } });
    const res = await new Client(h.app).get('/v1/feed', bearer(plain));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'max_required', error: 'API keys, webhooks and MCP need Max. Pro and Max open at token launch.' });
  });

  it('other Authorization schemes are not keys; routes without a key stay public', async () => {
    const res = await new Client(h.app).get('/v1/feed', { authorization: 'Basic dXNlcjpwYXNz' });
    expect(res.statusCode).toBe(200);
    expect((await new Client(h.app).get('/health', bearer('garbage'))).statusCode).toBe(200);
    // an unknown URL stays a 404, whatever key comes with it
    const nope = await new Client(h.app).get('/v1/nope', bearer('garbage'));
    expect(nope.statusCode).toBe(404);
    expect(nope.json().code).toBe('not_found');
  });
});

describe('per-key rate limit', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ TIER_OVERRIDES: `${maxW.address}:max`, API_KEY_RATE_PER_MIN: '3' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => resetState(h));

  it('API_KEY_RATE_PER_MIN per key (429 with Retry-After), separate per key and on top of the per-IP limit', async () => {
    const { c } = await maxClient(h);
    const a = await newKey(c);
    const b = await newKey(c);
    // different IPs: the per-key limit holds wherever the requests come from
    for (let i = 0; i < 3; i++) {
      const ok = await new Client(h.app, `198.51.100.${i + 1}`).get('/v1/feed', bearer(a.key));
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['x-key-ratelimit-limit']).toBe('3');
      expect(ok.headers['x-key-ratelimit-remaining']).toBe(String(2 - i));
    }
    const res = await new Client(h.app, '198.51.100.9').get('/v1/feed', bearer(a.key));
    expect(res.headers['x-key-ratelimit-remaining']).toBe('0');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ code: 'rate_limited', error: 'Too many requests with this API key. Wait a minute and try again.' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await new Client(h.app).get('/v1/feed', bearer(b.key))).statusCode).toBe(200);
    // the per-IP limit still applies to keyed traffic (x-ratelimit headers of the IP bucket)
    expect(res.headers['x-ratelimit-limit']).toBe('120');
    // without a key the same IP is unaffected
    expect((await new Client(h.app, '198.51.100.9').get('/v1/feed')).statusCode).toBe(200);
  });
});

describe('a key whose owner sold below Max (token live)', () => {
  const MINT = 'APEcheckMint1111111111111111111111111111111';
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ TOKEN_ADDRESS: MINT, TOKEN_CHAIN: 'sol', PRO_MIN_HOLD: '250000', MAX_MIN_HOLD: '2500000' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => resetState(h));

  it('works while the holding is Max; once the hourly re-read finds less, 403 max_required', async () => {
    const w = new SolWallet();
    h.sources.balances.set(w.address, 3_000_000);
    const { c, userId } = await maxClient(h, w);
    const k = await newKey(c);
    expect((await new Client(h.app).get('/v1/feed', bearer(k.key))).statusCode).toBe(200);
    h.sources.balances.set(w.address, 300_000);
    // the stored holding is trusted for an hour
    expect((await new Client(h.app).get('/v1/feed', bearer(k.key))).statusCode).toBe(200);
    await h.prisma.user.update({ where: { id: userId }, data: { tierCheckedAt: new Date(Date.now() - TIER_CACHE_MS - 1000) } });
    const res = await new Client(h.app).get('/v1/feed', bearer(k.key));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'max_required', error: 'API keys, webhooks and MCP need Max: hold 2,500,000 $APECHECK' });
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: userId } })).tier).toBe('PRO');
  });
});
