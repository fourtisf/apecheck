/** M3 tiers in the API: /v1/me, credits and priority by tier, private checks (Max), the token quote. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRIORITY, creditsKeyIp, creditsKeySid, creditsKeyUser, type CheckReportDTO, type CreateCheckResponse, type FeedResponse, type InsightsDTO, type LiveResponse, type MeDTO } from '@apecheck/core';
import { TIER_CACHE_MS } from '@apecheck/db';
import { Client, EvmWallet, SolWallet, makeHarness, resetState, seedCheck, seedTarget, signedIn, type Harness } from './helpers';

const MINT = 'APEcheckMint1111111111111111111111111111111';

describe('tiers while the token is not live', () => {
  let h: Harness;
  const team = new SolWallet();
  const tester = new EvmWallet();
  beforeAll(async () => {
    h = await makeHarness({ TIER_OVERRIDES: `${team.address}:max,${tester.address.toUpperCase().replace('0X', '0x')}:pro` });
  });
  afterAll(async () => h.close());
  beforeEach(async () => resetState(h));

  it('everyone is Free and nothing is read, holding requirements hidden', async () => {
    const me = await signedIn(new Client(h.app), new SolWallet());
    expect(me).toMatchObject({ tier: 'free', tokenLive: false, proMinHold: null, maxMinHold: null, max: 5, token: null });
    expect(me.user).toMatchObject({ tier: 'free', holding: null, holder: false });
    expect(h.sources.balanceCalls).toHaveLength(0);
  });

  it('TIER_OVERRIDES wallets get their tier and count as holders (EVM case-insensitive)', async () => {
    const max = await signedIn(new Client(h.app), team);
    expect(max).toMatchObject({ tier: 'max', max: 200, credits: 200 });
    expect(max.user).toMatchObject({ tier: 'max', holder: true, holding: null });
    const pro = await signedIn(new Client(h.app), tester);
    expect(pro).toMatchObject({ tier: 'pro', max: 30 });
    expect(await h.prisma.user.findUniqueOrThrow({ where: { evmAddress: tester.address } })).toMatchObject({ tier: 'PRO' });
  });
});

describe('tiers by holding', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ TOKEN_ADDRESS: MINT, TOKEN_CHAIN: 'sol', PRO_MIN_HOLD: '250000', MAX_MIN_HOLD: '2500000' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await resetState(h);
    h.sources.balances.clear();
    h.sources.balanceCalls = [];
  });

  it('reads the balance on sign-in and maps it to a tier', async () => {
    const w = new SolWallet();
    h.sources.balances.set(w.address, 300_000);
    const me = await signedIn(new Client(h.app), w);
    expect(me).toMatchObject({ tier: 'pro', tokenLive: true, proMinHold: 250000, maxMinHold: 2500000, max: 30, credits: 30 });
    expect(me.user).toMatchObject({ tier: 'pro', holding: 300000, holder: true });
    expect(h.sources.balanceCalls).toEqual([{ chain: 'sol', token: MINT, owner: w.address }]);
    const row = await h.prisma.user.findUniqueOrThrow({ where: { solAddress: w.address } });
    expect(row.tier).toBe('PRO');
    expect(Number(row.holding)).toBe(300000);
    expect(row.tierCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('/v1/me trusts the stored holding for an hour, then reads again', async () => {
    const w = new SolWallet();
    h.sources.balances.set(w.address, 300_000);
    const c = new Client(h.app);
    await signedIn(c, w);
    h.sources.balances.set(w.address, 3_000_000);
    expect((await c.get('/v1/me')).json<MeDTO>().tier).toBe('pro');
    expect(h.sources.balanceCalls).toHaveLength(1);

    await h.prisma.user.updateMany({ data: { tierCheckedAt: new Date(Date.now() - TIER_CACHE_MS - 1000) } });
    const me = (await c.get('/v1/me')).json<MeDTO>();
    expect(me).toMatchObject({ tier: 'max', max: 200 });
    expect(me.user?.holding).toBe(3_000_000);
    expect(h.sources.balanceCalls).toHaveLength(2);
  });

  it('a failed read keeps the last value', async () => {
    const w = new SolWallet();
    h.sources.balances.set(w.address, 300_000);
    const c = new Client(h.app);
    await signedIn(c, w);
    await h.prisma.user.updateMany({ data: { tierCheckedAt: new Date(Date.now() - 2 * TIER_CACHE_MS) } });
    h.sources.balances.set(w.address, null);
    const me = (await c.get('/v1/me')).json<MeDTO>();
    expect(me).toMatchObject({ tier: 'pro' });
    expect(me.user).toMatchObject({ holding: 300000, holder: true });
    // retried in a few minutes, not on every request
    const calls = h.sources.balanceCalls.length;
    await c.get('/v1/me');
    expect(h.sources.balanceCalls.length).toBe(calls);
  });

  it('a wallet that holds nothing is Free and not a holder; a wallet on another chain holds 0 without a read', async () => {
    const me = await signedIn(new Client(h.app), new SolWallet());
    expect(me.user).toMatchObject({ tier: 'free', holding: 0, holder: false });
    const evm = await signedIn(new Client(h.app), new EvmWallet());
    expect(evm.user).toMatchObject({ tier: 'free', holding: 0 });
    expect(h.sources.balanceCalls).toHaveLength(1);
  });

  it('the token quote comes from DexScreener, cached 60 s', async () => {
    h.sources.quote = { priceUsd: 0.00412, ch24: 6.1 };
    h.sources.dexCalls = 0;
    try {
      const c = new Client(h.app);
      expect((await c.get('/v1/me')).json<MeDTO>().token).toEqual({ usd: 0.00412, ch24: 6.1 });
      h.sources.quote = { priceUsd: 1, ch24: null };
      expect((await c.get('/v1/me')).json<MeDTO>().token).toEqual({ usd: 0.00412, ch24: 6.1 });
      expect(h.sources.dexCalls).toBe(1);
      expect(await h.redis.ttl(`token:quote:sol:${MINT}`)).toBeGreaterThan(55);
      await h.redis.del(`token:quote:sol:${MINT}`);
      h.sources.quote = null;
      expect((await c.get('/v1/me')).json<MeDTO>().token).toBeNull();
    } finally {
      h.sources.quote = null;
    }
  });

  describe('credits and priority by tier', () => {
    it('Pro counts per user with PRO_CHECKS_PER_DAY and gets the priority queue', async () => {
      const w = new SolWallet();
      h.sources.balances.set(w.address, 300_000);
      const c = new Client(h.app);
      await signedIn(c, w);
      const res = await c.post('/v1/checks', { target: 'pro-site.xyz' });
      expect(res.statusCode).toBe(201);
      expect(res.json<CreateCheckResponse>().credits).toBe(29);
      const check = await h.prisma.check.findFirstOrThrow({ include: { requester: true } });
      expect(check.requester?.solAddress).toBe(w.address);
      expect((await h.queue.getJob(check.id))!.opts.priority).toBe(PRIORITY.pro);
      const user = check.requester!;
      expect(await h.redis.get(creditsKeyUser(user.id))).toBe('1');
      // the anonymous counters are untouched
      expect(await h.redis.get(creditsKeySid(c.sid(h.app)!))).toBeNull();
      expect(await h.redis.get(creditsKeyIp('203.0.113.10'))).toBeNull();
      // and the next visitor on that IP still has all of theirs
      expect((await new Client(h.app).get('/v1/me')).json<MeDTO>().credits).toBe(5);
    });

    it('Max gets the top priority and MAX_CHECKS_PER_DAY', async () => {
      const w = new SolWallet();
      h.sources.balances.set(w.address, 9_000_000);
      const c = new Client(h.app);
      await signedIn(c, w);
      const body = (await c.post('/v1/checks', { target: 'max-site.xyz' })).json<CreateCheckResponse>();
      expect(body.credits).toBe(199);
      const check = await h.prisma.check.findUniqueOrThrow({ where: { shortId: body.id } });
      expect((await h.queue.getJob(check.id))!.opts.priority).toBe(PRIORITY.max);
    });

    it('a signed-in Free user keeps the cookie + IP budget: a new wallet is not a new day of checks', async () => {
      const c = new Client(h.app, '198.51.100.20');
      for (let i = 0; i < 3; i++) expect((await c.post('/v1/checks', { target: `anon${i}.xyz` })).statusCode).toBe(201);
      const me = await signedIn(c, new SolWallet());
      expect(me.credits).toBe(2);
      for (let i = 0; i < 2; i++) expect((await c.post('/v1/checks', { target: `free${i}.xyz` })).statusCode).toBe(201);
      expect((await c.post('/v1/checks', { target: 'free9.xyz' })).statusCode).toBe(402);
      // another fresh wallet on the same browser and IP: still out
      await signedIn(c, new SolWallet());
      expect((await c.post('/v1/checks', { target: 'free10.xyz' })).statusCode).toBe(402);
    });
  });
});

describe('private checks (Max)', () => {
  let h: Harness;
  let max: Client;
  let maxUserId: string;
  const maxWallet = new SolWallet();
  beforeAll(async () => {
    h = await makeHarness({ TIER_OVERRIDES: `${maxWallet.address}:max` });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await resetState(h);
    max = new Client(h.app);
    maxUserId = (await signedIn(max, maxWallet)).user!.id;
  });
  afterEach(() => undefined);

  it('Free users and anonymous visitors get 403 max_required without spending a credit', async () => {
    const anon = new Client(h.app);
    const res = await anon.post('/v1/checks', { target: 'secret.xyz', private: true });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'max_required', error: 'Private checks need Max. Pro and Max open at token launch.' });
    const free = new Client(h.app, '192.0.2.9');
    await signedIn(free, new EvmWallet());
    expect((await free.post('/v1/checks', { target: 'secret.xyz', private: true })).statusCode).toBe(403);
    expect((await free.get('/v1/me')).json<MeDTO>().credits).toBe(5);
    expect(await h.prisma.check.count()).toBe(0);
  });

  it('Max creates a private check visible only to its requester, without counting it publicly', async () => {
    const res = await max.post('/v1/checks', { target: 'secret.xyz', private: true });
    expect(res.statusCode).toBe(201);
    const { id } = res.json<CreateCheckResponse>();
    const check = await h.prisma.check.findUniqueOrThrow({ where: { shortId: id }, include: { target: true } });
    expect(check).toMatchObject({ isPrivate: true, requesterId: maxUserId });
    expect(check.target.checkCount).toBe(0);

    // the requester sees it, on any device they're signed in on
    const report = await max.get(`/v1/checks/${id}`);
    expect(report.statusCode).toBe(200);
    expect(report.headers['cache-control']).toBe('private, no-store');
    expect(report.json<CheckReportDTO>()).toMatchObject({ isPrivate: true, mine: true });
    const otherDevice = new Client(h.app, '192.0.2.44');
    await signedIn(otherDevice, maxWallet);
    expect((await otherDevice.get(`/v1/checks/${id}`)).statusCode).toBe(200);
    // nobody else does: report, SSE
    const stranger = new Client(h.app, '192.0.2.45');
    expect((await stranger.get(`/v1/checks/${id}`)).json()).toEqual({ code: 'not_found', error: "This check doesn't exist or has expired." });
    expect((await stranger.get(`/v1/checks/${id}/events`)).statusCode).toBe(404);
    await signedIn(stranger, new EvmWallet());
    expect((await stranger.get(`/v1/checks/${id}`)).statusCode).toBe(404);
    // not on /v1/live
    expect((await stranger.get('/v1/live')).json<LiveResponse>().items).toHaveLength(0);
    // signing out ends this browser's access, although its anonymous cookie started the check
    expect((await max.post('/v1/auth/logout')).statusCode).toBe(200);
    expect((await max.get(`/v1/checks/${id}`)).statusCode).toBe(404);
    expect((await max.get(`/v1/checks/${id}/events`)).statusCode).toBe(404);
    await signedIn(max, maxWallet);
    expect((await max.get(`/v1/checks/${id}`)).statusCode).toBe(200);
  });

  it('a second private submit returns the same running check; a public request never gets the private one', async () => {
    const first = (await max.post('/v1/checks', { target: 'twice.xyz', private: true })).json<CreateCheckResponse>();
    const again = await max.post('/v1/checks', { target: 'twice.xyz', private: true });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.id, status: 'queued', cached: false });
    const pub = await max.post('/v1/checks', { target: 'twice.xyz' });
    expect(pub.statusCode).toBe(201);
    expect(pub.json<CreateCheckResponse>().id).not.toBe(first.id);
    // and a private request reuses a public run in progress (already public: nothing to hide)
    const third = await max.post('/v1/checks', { target: 'twice.xyz', private: true });
    expect(third.json<CreateCheckResponse>().id).toBe(pub.json<CreateCheckResponse>().id);
  });

  it('finished private checks stay out of the feed, coins, insights and watched ids', async () => {
    const t = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca: 'PrivMint', ticker: 'PRIV', name: '$PRIV', key: 'ca:sol:PrivMint', checkCount: 0, lastPrice: '2' });
    await seedCheck(h.prisma, {
      targetId: t.id, shortId: 'priv001', isPrivate: true, isLatest: true, requesterId: maxUserId, totalScore: 80, narScore: 80, narBand: 'real',
      coinScore: 80, coinBand: 'clean', priceAtCheck: '1',
    });
    await h.prisma.coinFacts.create({ data: { checkId: (await h.prisma.check.findUniqueOrThrow({ where: { shortId: 'priv001' } })).id, sigDeployer: 'OK', sigBundle: 'OK', sigHolders: 'OK', sigLp: 'OK', sigAuthorities: 'OK' } });
    for (const c of [new Client(h.app), max]) {
      expect((await c.get('/v1/feed')).json<FeedResponse>().total).toBe(0);
      expect((await c.get('/v1/feed?ids=priv001')).json<FeedResponse>().items).toHaveLength(0);
      expect((await c.get('/v1/coins')).json<{ total: number }>().total).toBe(0);
      const ins = (await c.get('/v1/insights')).json<InsightsDTO>();
      expect(ins.stats.checked).toBe(0);
      expect(ins.mostChecked).toHaveLength(0);
      expect(ins.sinceByVerdict).toHaveLength(0);
    }
    expect((await max.get('/v1/checks/priv001')).statusCode).toBe(200);
  });
});
