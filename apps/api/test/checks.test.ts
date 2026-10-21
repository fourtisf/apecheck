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

  it('serves a recent "Not enough to check" like a cached verdict (status failed, no credit); an outage, an old one or recheck:true runs again', async () => {
    const NONE = "Not enough to check: ApeCheck doesn't read X profiles, and no GitHub repo was found for @stridefun. Tag me under a post with its link or contract.";
    const t = await seedTarget(h.prisma, { kind: 'POST', handle: 'stridefun', key: 'x:stridefun', name: '@stridefun', domain: null });
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'none001', status: 'FAILED', error: NONE, isLatest: false, finishedAt: new Date(Date.now() - 2 * 3600_000) });
    const c = new Client(h.app);
    const hit = await c.post('/v1/checks', { target: 'https://x.com/stridefun' });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toEqual({ id: 'none001', status: 'failed', cached: true, credits: 5 });
    const re = await c.post('/v1/checks', { target: 'https://x.com/stridefun', recheck: true });
    expect(re.statusCode).toBe(201);
    expect(re.json<CreateCheckResponse>()).toMatchObject({ status: 'queued', cached: false, credits: 4 });

    // an outage that left nothing tested is a failed run like any other: never served from the cache
    const o = await seedTarget(h.prisma, { kind: 'POST', handle: 'escoeco', key: 'x:escoeco', name: '@escoeco', domain: null });
    await seedCheck(h.prisma, { targetId: o.id, shortId: 'down001', status: 'FAILED', error: "Nothing about @escoeco could be checked: GitHub didn't answer", isLatest: false });
    const outage = await c.post('/v1/checks', { target: 'https://x.com/escoeco' });
    expect(outage.statusCode).toBe(201);
    expect(outage.json<CreateCheckResponse>().id).not.toBe('down001');

    const old = await seedTarget(h.prisma, { kind: 'POST', handle: 'oldnone', key: 'x:oldnone', name: '@oldnone', domain: null });
    await seedCheck(h.prisma, { targetId: old.id, shortId: 'none002', status: 'FAILED', error: NONE, isLatest: false, finishedAt: new Date(Date.now() - 7 * 3600_000) });
    expect((await c.post('/v1/checks', { target: 'https://x.com/oldnone' })).statusCode).toBe(201);
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

  it('a contract the worker moved to the website in its token info (on a chain ApeCheck can\'t read) is still matched by what was pasted', async () => {
    const SONIC = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
    const c = new Client(h.app);
    const first = await c.post('/v1/checks', { target: SONIC });
    expect(first.statusCode).toBe(201);
    const id = first.json<CreateCheckResponse>().id;
    // the worker: the contract trades only on Sonic, its token info links esco.example, which already has a Target
    // (with its own coin): the check is re-pointed there and the preliminary "ca:evm:" row is dropped
    const site = await seedTarget(h.prisma, { kind: 'SITE', domain: 'esco.example', key: 'site:esco.example', name: 'esco.example', chain: 'BASE', ca: EVM });
    const pre = await h.prisma.check.findUniqueOrThrow({ where: { shortId: id } });
    await h.prisma.check.update({ where: { id: pre.id }, data: { targetId: site.id, status: 'RUNNING', startedAt: new Date() } });
    await h.prisma.target.delete({ where: { id: pre.targetId } });

    // a second paste (any case) joins the run: no credit, no second check
    const again = await new Client(h.app, '192.0.2.78').post('/v1/checks', { target: '0x' + SONIC.slice(2).toUpperCase() });
    expect(again.json()).toEqual({ id, status: 'running', cached: false, credits: 5 });
    // once it is done, the next one gets the cached verdict
    await h.prisma.check.update({ where: { id: pre.id }, data: { status: 'DONE', finishedAt: new Date(), evidence: { otherChain: { chain: 'Sonic', address: SONIC, site: 'esco.example' } } } });
    const hit = await c.post('/v1/checks', { target: SONIC });
    expect(hit.json()).toEqual({ id, status: 'done', cached: true, credits: 4 });
    expect(await h.prisma.check.count()).toBe(1);
    // a paste of another contract (here the site's own coin on Base) is not answered by this check
    expect((await c.post('/v1/checks', { target: EVM })).json()).toMatchObject({ cached: false, status: 'queued' });
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
    // 22:30 UTC tomorrow: the expiry must still be ahead of the real clock, or Redis drops the key at once
    const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const now = new Date(`${day}T22:30:00Z`);
    const midnight = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000);
    const subject = { sid: 'sid-expiry', ip: '10.1.1.1' };
    await consumeCredit(h.redis, h.env, subject, now);
    const exp = await h.redis.expiretime(creditsKeySid(subject.sid, day));
    expect(exp).toBe(midnight.getTime() / 1000 + 3600);
    expect(await h.redis.get(creditsKeyIp(subject.ip, day))).toBe('1');
    const state = await getCredits(h.redis, h.env, subject, now);
    expect(state).toEqual({ credits: 4, max: 5, resetsAt: midnight });
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
