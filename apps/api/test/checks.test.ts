import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRIORITY, creditsKeyIp, creditsKeySid, type CreateCheckResponse, type MeDTO } from '@apecheck/core';
import { consumeCredit, getCredits } from '../src/credits';
import { Client, makeHarness, resetState, seedCheck, seedTarget, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetState(h);
});

const EVM = '0xabcdef0123456789abcdef0123456789abcdef01';
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

describe('POST /v1/checks', () => {
  it('rejects empty, missing and unrecognised targets with bad_target', async () => {
    const c = new Client(h.app);
    for (const payload of [{ target: '' }, { target: '   ' }, { target: 'hello world' }, {}, { target: 42 }]) {
      const res = await c.post('/v1/checks', payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ code: 'bad_target', error: 'Paste a contract address, an X post link or a website' });
    }
    expect(await h.prisma.check.count()).toBe(0);
    // nothing was spent
    expect((await c.get('/v1/me')).json<MeDTO>().credits).toBe(5);
  });

  it('creates a queued check, the target and a BullMQ job', async () => {
    const c = new Client(h.app);
    const res = await c.post('/v1/checks', { target: 'https://www.OrbitSwap.xyz/app?ref=1' });
    expect(res.statusCode).toBe(201);
    const body = res.json<CreateCheckResponse>();
    expect(body).toEqual({ id: expect.stringMatching(/^[a-z0-9]{7}$/), status: 'queued', cached: false, credits: 4 });

    const check = await h.prisma.check.findUniqueOrThrow({ where: { shortId: body.id }, include: { target: true } });
    expect(check).toMatchObject({
      status: 'QUEUED',
      via: 'WEB',
      isPrivate: false,
      isLatest: false,
      targetRaw: 'https://www.OrbitSwap.xyz/app?ref=1',
      postId: null,
      requesterSid: c.sid(h.app),
    });
    expect(check.target).toMatchObject({ kind: 'SITE', key: 'site:orbitswap.xyz', domain: 'orbitswap.xyz', name: 'orbitswap.xyz', chain: null, checkCount: 1 });

    const job = await h.queue.getJob(check.id);
    expect(job).toBeTruthy();
    expect(job!.name).toBe('check');
    expect(job!.data).toEqual({ checkId: check.id });
    expect(job!.opts.priority).toBe(PRIORITY.free);
    expect(await job!.getState()).toBe('prioritized');
  });

  it('seeds coin, post and profile targets with preliminary names', async () => {
    const c = new Client(h.app);
    await c.post('/v1/checks', { target: '0x' + EVM.slice(2).toUpperCase() });
    await c.post('/v1/checks', { target: SOL });
    await c.post('/v1/checks', { target: 'https://x.com/kairolabs/status/1849000000000000001' });
    await c.post('/v1/checks', { target: 'https://x.com/prismfi_' });
    const targets = await h.prisma.target.findMany({ orderBy: { createdAt: 'asc' } });
    expect(targets.map(t => ({ kind: t.kind, key: t.key, name: t.name, chain: t.chain, ca: t.ca, handle: t.handle }))).toEqual([
      { kind: 'COIN', key: `ca:evm:${EVM}`, name: '0xabc…ef01', chain: null, ca: EVM, handle: null },
      { kind: 'COIN', key: `ca:sol:${SOL}`, name: '7xKXt…gAsU', chain: 'SOL', ca: SOL, handle: null },
      { kind: 'POST', key: 'post:1849000000000000001', name: '@kairolabs', chain: null, ca: null, handle: 'kairolabs' },
      { kind: 'POST', key: 'x:prismfi_', name: '@prismfi_', chain: null, ca: null, handle: 'prismfi_' },
    ]);
    const post = await h.prisma.check.findFirstOrThrow({ where: { target: { key: 'post:1849000000000000001' } } });
    expect(post.postId).toBe('1849000000000000001');
  });

  it('allows FREE_CHECKS_PER_DAY checks, then answers 402 no_credits', async () => {
    const c = new Client(h.app);
    for (let i = 1; i <= 5; i++) {
      const res = await c.post('/v1/checks', { target: `project${i}.xyz` });
      expect(res.statusCode).toBe(201);
      expect(res.json<CreateCheckResponse>().credits).toBe(5 - i);
    }
    const res = await c.post('/v1/checks', { target: 'project6.xyz' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({
      code: 'no_credits',
      error: "You've used today's free checks. Hold $APECHECK for more, or come back after 00:00 UTC.",
    });
    expect(await h.prisma.check.count()).toBe(5);
    const me = (await c.get('/v1/me')).json<MeDTO>();
    expect(me.credits).toBe(0);
    expect(me.max).toBe(5);
  });

  it('counts per IP as well: a fresh cookie on the same IP shares the IP budget', async () => {
    const a = new Client(h.app, '198.51.100.7');
    for (let i = 1; i <= 5; i++) expect((await a.post('/v1/checks', { target: `ip${i}.xyz` })).statusCode).toBe(201);
    const b = new Client(h.app, '198.51.100.7');
    expect((await b.post('/v1/checks', { target: 'ip6.xyz' })).statusCode).toBe(402);
    expect((await b.get('/v1/me')).json<MeDTO>().credits).toBe(0);
    // and the cookie travels: same sid from another IP is still out
    const moved = new Client(h.app, '198.51.100.99');
    moved.cookie = a.cookie;
    expect((await moved.post('/v1/checks', { target: 'ip7.xyz' })).statusCode).toBe(402);
    // another visitor elsewhere is unaffected
    expect((await new Client(h.app, '192.0.2.50').post('/v1/checks', { target: 'ip8.xyz' })).statusCode).toBe(201);
  });

  it('returns a queued/running check for the same target instead of starting another (no credit)', async () => {
    const c = new Client(h.app);
    const first = (await c.post('/v1/checks', { target: 'dupe.xyz' })).json<CreateCheckResponse>();
    const again = await c.post('/v1/checks', { target: 'https://dupe.xyz/' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: first.id, status: 'queued', cached: false, credits: 4 });

    await h.prisma.check.update({ where: { shortId: first.id }, data: { status: 'RUNNING', startedAt: new Date() } });
    const other = new Client(h.app, '192.0.2.77');
    const res = await other.post('/v1/checks', { target: 'www.dupe.xyz', recheck: true });
    expect(res.json()).toEqual({ id: first.id, status: 'running', cached: false, credits: 5 });
    expect(await h.prisma.check.count()).toBe(1);
    expect((await h.prisma.target.findFirstOrThrow()).checkCount).toBe(1);
  });

  it('does not let a dead run (worker crashed) block new checks of the target', async () => {
    const t = await seedTarget(h.prisma, { kind: 'SITE', domain: 'stuck.xyz', key: 'site:stuck.xyz', name: 'stuck.xyz' });
    // RUNNING far beyond 2x CHECK_BUDGET_SECONDS, QUEUED for more than two hours
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'stuck01', status: 'RUNNING', startedAt: new Date(Date.now() - 3600_000) });
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'stuck02', status: 'QUEUED', startedAt: null, createdAt: new Date(Date.now() - 3 * 3600_000) });
    const res = await new Client(h.app).post('/v1/checks', { target: 'stuck.xyz' });
    expect(res.statusCode).toBe(201);
    expect(res.json<CreateCheckResponse>().id).not.toMatch(/^stuck/);
  });

  it('serves a DONE check younger than CACHE_HOURS from cache; recheck:true runs a new one', async () => {
    const t = await seedTarget(h.prisma, { kind: 'SITE', domain: 'cached.xyz', key: 'site:cached.xyz', name: 'cached.xyz', checkCount: 3 });
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'cache01', finishedAt: new Date(Date.now() - 2 * 3600_000) });
    const c = new Client(h.app);
    const hit = await c.post('/v1/checks', { target: 'cached.xyz' });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toEqual({ id: 'cache01', status: 'done', cached: true, credits: 5 });
    expect(await h.prisma.check.count()).toBe(1);

    const re = await c.post('/v1/checks', { target: 'cached.xyz', recheck: true });
    expect(re.statusCode).toBe(201);
    const body = re.json<CreateCheckResponse>();
    expect(body).toMatchObject({ status: 'queued', cached: false, credits: 4 });
    expect(body.id).not.toBe('cache01');
    const target = await h.prisma.target.findUniqueOrThrow({ where: { id: t.id } });
    expect(target.checkCount).toBe(4);
    expect(await h.prisma.check.count({ where: { targetId: t.id } })).toBe(2);
  });

  it('runs again when the cached verdict is older than CACHE_HOURS, and ignores private checks', async () => {
    const t = await seedTarget(h.prisma, { kind: 'SITE', domain: 'old.xyz', key: 'site:old.xyz', name: 'old.xyz' });
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'old0001', finishedAt: new Date(Date.now() - 7 * 3600_000) });
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'priv001', isPrivate: true, isLatest: false, finishedAt: new Date() });
    const res = await new Client(h.app).post('/v1/checks', { target: 'old.xyz' });
    expect(res.statusCode).toBe(201);
    expect(res.json<CreateCheckResponse>().cached).toBe(false);
  });

  it('matches coins by address across chain keys and reuses the resolved target', async () => {
    const t = await seedTarget(h.prisma, { kind: 'COIN', ca: EVM, chain: 'BASE', key: `ca:base:${EVM}`, name: '$ORBIT', ticker: 'ORBIT' });
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'coin001', finishedAt: new Date(Date.now() - 600_000) });
    const c = new Client(h.app);
    const mixedCase = '0x' + EVM.slice(2).toUpperCase();
    const hit = await c.post('/v1/checks', { target: mixedCase });
    expect(hit.json()).toMatchObject({ id: 'coin001', cached: true });

    const re = await c.post('/v1/checks', { target: mixedCase, recheck: true });
    expect(re.statusCode).toBe(201);
    expect(await h.prisma.target.count()).toBe(1);
    const check = await h.prisma.check.findUniqueOrThrow({ where: { shortId: re.json<CreateCheckResponse>().id } });
    expect(check.targetId).toBe(t.id);
  });

  it('matches posts by tweet id whatever the URL looks like', async () => {
    const c = new Client(h.app);
    const first = (await c.post('/v1/checks', { target: 'https://x.com/kairolabs/status/1849000000000000002' })).json<CreateCheckResponse>();
    const again = await c.post('/v1/checks', { target: 'https://twitter.com/i/web/status/1849000000000000002?s=20' });
    expect(again.json()).toMatchObject({ id: first.id, cached: false, status: 'queued' });
  });

  it('refuses private checks (Max only) without spending a credit', async () => {
    const c = new Client(h.app);
    const res = await c.post('/v1/checks', { target: 'secret.xyz', private: true });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'max_required', error: 'Private checks need Max. Pro and Max open at token launch.' });
    expect((await c.get('/v1/me')).json<MeDTO>().credits).toBe(5);
  });

  it('collapses concurrent double submits into one check', async () => {
    const c = new Client(h.app);
    await c.get('/v1/me');
    const [a, b] = await Promise.all([c.post('/v1/checks', { target: 'double.xyz' }), c.post('/v1/checks', { target: 'double.xyz' })]);
    expect(a.json<CreateCheckResponse>().id).toBe(b.json<CreateCheckResponse>().id);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(await h.prisma.check.count()).toBe(1);
  });

  it('limits POST /v1/checks to 10 a minute per IP', async () => {
    const c = new Client(h.app, '192.0.2.200');
    for (let i = 0; i < 10; i++) expect((await c.post('/v1/checks', { target: '' })).statusCode).toBe(400);
    const res = await c.post('/v1/checks', { target: 'x.xyz' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'rate_limited' });
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('credits', () => {
  it('consumes atomically and never overspends under concurrency', async () => {
    const subject = { sid: 'sid-concurrency', ip: '10.9.8.7' };
    const results = await Promise.all(Array.from({ length: 12 }, () => consumeCredit(h.redis, h.env, subject)));
    expect(results.filter(r => r.ok)).toHaveLength(5);
    expect(results.filter(r => !r.ok).every(r => r.credits === 0)).toBe(true);
    expect((await getCredits(h.redis, h.env, subject)).credits).toBe(0);
  });

  it('expires counters an hour after the next UTC midnight', async () => {
    const now = new Date('2026-10-19T22:30:00Z');
    const subject = { sid: 'sid-expiry', ip: '10.1.1.1' };
    await consumeCredit(h.redis, h.env, subject, now);
    const exp = await h.redis.expiretime(creditsKeySid(subject.sid, '2026-10-19'));
    expect(exp).toBe(Date.parse('2026-10-20T01:00:00Z') / 1000);
    expect(await h.redis.get(creditsKeyIp(subject.ip, '2026-10-19'))).toBe('1');
    const state = await getCredits(h.redis, h.env, subject, now);
    expect(state).toEqual({ credits: 4, max: 5, resetsAt: new Date('2026-10-20T00:00:00Z') });
  });
});

describe('gated endpoints (M3)', () => {
  it('answers asks with pro_required, notes with holders_only, watch with sign_in_required', async () => {
    const c = new Client(h.app);
    const ask = await c.post('/v1/checks/abc1234/asks', { question: 'who funded the deployer?' });
    expect(ask.statusCode).toBe(403);
    expect(ask.json()).toEqual({ code: 'pro_required', error: 'Follow-ups need Pro. Pro and Max open at token launch.' });
    const note = await c.post('/v1/checks/abc1234/notes', { text: 'x' });
    expect(note.statusCode).toBe(403);
    expect(note.json()).toEqual({ code: 'holders_only', error: 'Notes are open to $APECHECK holders. Connect a wallet to add one.' });
    const helpful = await c.post('/v1/notes/n1/helpful');
    expect(helpful.statusCode).toBe(403);
    expect(helpful.json().code).toBe('holders_only');
    const watch = await c.post('/v1/watch/t1');
    expect(watch.statusCode).toBe(401);
    expect(watch.json().code).toBe('sign_in_required');
  });

  it('quotes the Pro holding once the token is live', async () => {
    const live = await makeHarness({ TOKEN_ADDRESS: 'ApeCheckTokenMint1111111111111111111111111', PRO_MIN_HOLD: '250000' });
    try {
      const res = await new Client(live.app).post('/v1/checks/abc1234/asks', {});
      expect(res.json()).toEqual({ code: 'pro_required', error: 'Follow-ups need Pro: hold 250,000 $APECHECK' });
      const me = (await new Client(live.app).get('/v1/me')).json<MeDTO>();
      expect(me).toMatchObject({ tokenLive: true, proMinHold: 250000, maxMinHold: 2500000, tier: 'free', user: null });
    } finally {
      await live.close();
    }
  });
});
