import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  progressKey,
  type BotStatsDTO,
  type CoinsResponse,
  type DeployersResponse,
  type FeedResponse,
  type InsightsDTO,
  type LiveResponse,
} from '@apecheck/core';
import { Client, makeHarness, resetState, seedCheck, seedCoinFacts, seedDeployer, seedTarget, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});

const startOfToday = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
/** a moment today, `agoMs` before now but never before 00:00:01 UTC (keeps the test stable around midnight) */
const today = (agoMs: number) => new Date(Math.max(startOfToday().getTime() + 1000, Date.now() - agoMs));
const yesterday = () => new Date(startOfToday().getTime() - 3600_000);
const ago = (ms: number) => new Date(Date.now() - ms);
const min = (n: number) => n * 60_000;

const D1_ADDR = 'BuiLdErWaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const D2_ADDR = '0x2222222222222222222222222222222222222222';
const D3_ADDR = 'SeRiALWaLLetCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

let viewer: Client;
let ids: Record<string, string>;

/**
 * A: coin $ORBIT (sol)        total 80 real,   coin 78 ok,      checked 10, vol 500,  web, mine
 * B: post @kairolabs          total 30 llarp,  no coin,         checked 50,           bot
 * C: site helixdex.app (base) total 55 partly, coin 40 sketchy, checked 2,  vol 9000, bot
 * D: coin $NEXA (base)        total 15 larp,   coin 20 rigged,  checked 1,  vol null
 * not on the feed: an older check of A, a running check, a private check, a failed check
 */
async function seedFeed() {
  await resetState(h);
  viewer = new Client(h.app, '203.0.113.33');
  await viewer.get('/v1/me');
  const sid = viewer.sid(h.app)!;

  const d1 = await seedDeployer(h.prisma, { chain: 'SOL', address: D1_ADDR, record: 'BUILDER', launched: 2, dead: 0 });
  const d2 = await seedDeployer(h.prisma, { chain: 'BASE', address: D2_ADDR, record: 'MIXED', launched: 6, dead: 2 });
  await seedDeployer(h.prisma, { chain: 'SOL', address: D3_ADDR, record: 'SERIAL', launched: 30, dead: 25 });

  const tA = await seedTarget(h.prisma, {
    kind: 'COIN', chain: 'SOL', ca: 'OrbitMint1111111111111111111111111111111111', ticker: 'ORBIT', name: '$ORBIT',
    key: 'ca:sol:OrbitMint1111111111111111111111111111111111', checkCount: 10, lastVol5m: '500', lastPrice: '1.5', lastMc: '2000000',
  });
  const tB = await seedTarget(h.prisma, { kind: 'POST', handle: 'kairolabs', name: '@kairolabs', key: 'post:1849', checkCount: 50 });
  const tC = await seedTarget(h.prisma, {
    kind: 'SITE', chain: 'BASE', domain: 'helixdex.app', name: 'helixdex.app', key: 'site:helixdex.app', checkCount: 2, lastVol5m: '9000', lastPrice: '2.2',
  });
  const tD = await seedTarget(h.prisma, {
    kind: 'COIN', chain: 'BASE', ca: '0x4444444444444444444444444444444444444444', ticker: 'NEXA', name: '$NEXA',
    key: 'ca:base:0x4444444444444444444444444444444444444444', checkCount: 1, lastPrice: '0.4',
  });

  const A = await seedCheck(h.prisma, {
    targetId: tA.id, shortId: 'aaaa001', totalScore: 80, narScore: 82, narBand: 'real', coinScore: 78, coinBand: 'ok',
    requesterSid: sid, priceAtCheck: '1', createdAt: today(min(12)), finishedAt: ago(min(10)),
  });
  await seedCoinFacts(h.prisma, A.id, { deployerId: d1.id, bundlePct: 2.5, top10Pct: 18, devHoldPct: 1.2, lpStatus: 'burned', authorities: 'Renounced' });
  const E = await seedCheck(h.prisma, { targetId: tA.id, shortId: 'aaaa000', isLatest: false, totalScore: 60, createdAt: today(min(50)), finishedAt: ago(min(45)) });
  await h.prisma.pricePoint.createMany({
    data: [
      { targetId: tA.id, ts: new Date(A.finishedAt!.getTime() + 1000), price: '1.2' },
      { targetId: tA.id, ts: new Date(A.finishedAt!.getTime() + 2000), price: '1.5' },
    ],
  });

  const B = await seedCheck(h.prisma, {
    targetId: tB.id, shortId: 'bbbb001', totalScore: 30, narScore: 30, narBand: 'llarp', via: 'BOT', requesterHandle: 'solsleuth',
    postId: '1849', createdAt: today(min(22)), finishedAt: ago(min(20)),
  });
  await seedCheck(h.prisma, { targetId: tB.id, shortId: 'bbbb002', isLatest: false, totalScore: 31, createdAt: today(min(40)), finishedAt: ago(min(39)) });
  await seedCheck(h.prisma, { targetId: tB.id, shortId: 'bbbb003', isLatest: false, totalScore: 32, createdAt: today(min(60)), finishedAt: ago(min(59)) });

  const C = await seedCheck(h.prisma, {
    targetId: tC.id, shortId: 'cccc001', totalScore: 55, narScore: 70, narBand: 'partly', coinScore: 40, coinBand: 'sketchy', via: 'BOT',
    priceAtCheck: '2', createdAt: today(min(6)), finishedAt: ago(min(5)),
  });
  await seedCoinFacts(h.prisma, C.id, { deployerId: d2.id, sigBundle: 'WARN' });

  const D = await seedCheck(h.prisma, {
    targetId: tD.id, shortId: 'dddd001', totalScore: 15, narScore: 10, narBand: 'larp', coinScore: 20, coinBand: 'rigged',
    priceAtCheck: '1', createdAt: yesterday(), finishedAt: ago(min(30)),
  });
  await seedCoinFacts(h.prisma, D.id, { deployerId: d2.id, sigDeployer: 'FAIL', lpStatus: 'unlocked' });

  // excluded from every list
  const tX = await seedTarget(h.prisma, { kind: 'SITE', domain: 'hidden.xyz', name: 'hidden.xyz', key: 'site:hidden.xyz' });
  await seedCheck(h.prisma, { targetId: tX.id, shortId: 'xxxx001', status: 'RUNNING', createdAt: today(min(1)) });
  await seedCheck(h.prisma, { targetId: tX.id, shortId: 'xxxx002', isPrivate: true, isLatest: true, totalScore: 99, createdAt: yesterday() });
  await seedCheck(h.prisma, { targetId: tX.id, shortId: 'xxxx003', status: 'FAILED', isLatest: false, createdAt: yesterday() });

  ids = { A: A.shortId, B: B.shortId, C: C.shortId, D: D.shortId, E: E.shortId };
}

const feed = async (qs = '') => {
  const res = await viewer.get(`/v1/feed${qs}`);
  expect(res.statusCode).toBe(200);
  return res.json<FeedResponse>();
};
const order = (r: { items: { id: string }[] }) => r.items.map(i => i.id);

describe('GET /v1/feed', () => {
  beforeAll(seedFeed);

  it('sorts every tab like the prototype', async () => {
    expect(order(await feed())).toEqual(['cccc001', 'aaaa001', 'bbbb001', 'dddd001']);
    expect(order(await feed('?tab=latest'))).toEqual(['cccc001', 'aaaa001', 'bbbb001', 'dddd001']);
    expect(order(await feed('?tab=checked'))).toEqual(['bbbb001', 'aaaa001', 'cccc001', 'dddd001']);
    expect(order(await feed('?tab=real'))).toEqual(['aaaa001', 'cccc001', 'bbbb001', 'dddd001']);
    expect(order(await feed('?tab=least'))).toEqual(['dddd001', 'bbbb001', 'cccc001', 'aaaa001']);
    // coins only, biggest 5m volume first, unknown volume last
    expect(order(await feed('?tab=vol'))).toEqual(['cccc001', 'aaaa001', 'dddd001']);
    expect((await feed()).total).toBe(4);
  });

  it('filters by type, verdicts and chain', async () => {
    expect(order(await feed('?type=coin'))).toEqual(['aaaa001', 'dddd001']);
    expect(order(await feed('?type=post'))).toEqual(['bbbb001']);
    expect(order(await feed('?type=site'))).toEqual(['cccc001']);
    expect(order(await feed('?nar=llarp'))).toEqual(['bbbb001']);
    expect(order(await feed('?coin=sketchy'))).toEqual(['cccc001']);
    expect(order(await feed('?chain=base'))).toEqual(['cccc001', 'dddd001']);
    expect(order(await feed('?chain=any&nar=any&coin=any&type=all'))).toHaveLength(4);
    expect(order(await feed('?nar=&coin=&chain=&q='))).toHaveLength(4);
    expect((await feed('?type=coin&coin=rigged')).total).toBe(1);
  });

  it('searches name, ticker, domain, handle, CA and the deployer wallet', async () => {
    expect(order(await feed('?q=%24orb'))).toEqual(['aaaa001']);
    expect(order(await feed('?q=%40KAIRO'))).toEqual(['bbbb001']);
    expect(order(await feed('?q=helix'))).toEqual(['cccc001']);
    expect(order(await feed('?q=nexa'))).toEqual(['dddd001']);
    expect(order(await feed('?q=0x44444'))).toEqual(['dddd001']);
    expect(order(await feed(`?q=${D1_ADDR.slice(0, 12).toLowerCase()}`))).toEqual(['aaaa001']);
    expect(order(await feed(`?q=${D2_ADDR.slice(0, 10)}`))).toEqual(['cccc001', 'dddd001']);
    expect((await feed('?q=nothing-like-this')).total).toBe(0);
  });

  it('limits to watched ids (following re-checks) and to bot checks', async () => {
    expect(order(await feed(`?tab=watch&ids=${ids.B},${ids.D}`))).toEqual(['bbbb001', 'dddd001']);
    // an id from an older check of the same target still finds the target's latest verdict
    expect(order(await feed(`?tab=watch&ids=${ids.E}`))).toEqual(['aaaa001']);
    expect(await feed('?tab=watch')).toEqual({ items: [], total: 0, nextCursor: null });
    expect(await feed('?ids=zzzzzzz')).toEqual({ items: [], total: 0, nextCursor: null });
    expect(order(await feed('?via=bot'))).toEqual(['cccc001', 'bbbb001']);
    expect(order(await feed('?via=bot&tab=real'))).toEqual(['cccc001', 'bbbb001']);
  });

  it('pages with an opaque cursor', async () => {
    const p1 = await feed('?limit=3');
    expect(order(p1)).toEqual(['cccc001', 'aaaa001', 'bbbb001']);
    expect(p1.total).toBe(4);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const p2 = await feed(`?limit=3&cursor=${p1.nextCursor}`);
    expect(order(p2)).toEqual(['dddd001']);
    expect(p2.nextCursor).toBeNull();
    const bad = await viewer.get('/v1/feed?cursor=not-a-cursor');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('bad_request');
  });

  it('rejects unknown filter values', async () => {
    for (const qs of ['?tab=hot', '?type=nft', '?nar=great', '?chain=doge', '?limit=0', '?limit=1000']) {
      const res = await viewer.get(`/v1/feed${qs}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('bad_request');
    }
  });

  it('shapes rows as CheckSummaryDTO with spark, mine and deployer', async () => {
    const a = (await feed('?q=orbit')).items[0];
    expect(a).toMatchObject({
      id: 'aaaa001', kind: 'coin', status: 'done', name: '$ORBIT', title: 'Orbit', ticker: 'ORBIT', chain: 'sol',
      total: 80, narBand: 'real', coinBand: 'ok', hasCoin: true, mc: 2000000, vol5m: 500, since: 50,
      spark: [0, 20, 50], checks: 10, via: 'web', by: null, mine: true,
      deployer: { address: D1_ADDR, chain: 'sol', record: 'builder' },
    });
    const b = (await feed('?q=kairo')).items[0];
    expect(b).toMatchObject({ kind: 'post', title: 'Kairo', hasCoin: false, mc: null, since: null, spark: null, via: 'bot', by: 'solsleuth', mine: false, deployer: null });
    const anon = (await new Client(h.app).get('/v1/feed?q=orbit')).json<FeedResponse>();
    expect(anon.items[0].mine).toBe(false);
  });
});

describe('GET /v1/coins', () => {
  beforeAll(seedFeed);

  it('lists latest coin verdicts by coin score with filters', async () => {
    const all = (await viewer.get('/v1/coins')).json<CoinsResponse>();
    expect(order(all)).toEqual(['aaaa001', 'cccc001', 'dddd001']);
    expect(all.total).toBe(3);
    expect(all.items[0].facts).toEqual({
      sig: { deployer: 'ok', bundle: 'ok', holders: 'ok', lp: 'ok', authorities: 'ok' },
      bundlePct: 2.5, top10Pct: 18, devHoldPct: 1.2, lpLabel: 'Burned', authorities: 'Renounced', deployerRecord: 'builder',
    });
    expect(all.items[2].facts).toMatchObject({ sig: { deployer: 'fail' }, lpLabel: 'Unlocked', deployerRecord: 'mixed' });
    expect(order((await viewer.get('/v1/coins?tab=sketchy')).json<CoinsResponse>())).toEqual(['cccc001']);
    expect(order((await viewer.get('/v1/coins?tab=all&chain=sol')).json<CoinsResponse>())).toEqual(['aaaa001']);
    expect(order((await viewer.get('/v1/coins?chain=base')).json<CoinsResponse>())).toEqual(['cccc001', 'dddd001']);
    expect(order((await viewer.get('/v1/coins?q=%24nexa')).json<CoinsResponse>())).toEqual(['dddd001']);
    expect(order((await viewer.get(`/v1/coins?q=${D1_ADDR.slice(0, 8)}`)).json<CoinsResponse>())).toEqual(['aaaa001']);
  });
});

describe('GET /v1/deployers', () => {
  beforeAll(seedFeed);

  it('lists every deployer with their checked coins and sorts by record', async () => {
    const real = (await viewer.get('/v1/deployers')).json<DeployersResponse>();
    expect(real.items.map(d => d.address)).toEqual([D1_ADDR, D2_ADDR, D3_ADDR]);
    expect(real.items[0]).toMatchObject({ chain: 'sol', record: 'builder', launched: 2, dead: 0, checked: 1, real: 1, avgTotal: 80 });
    expect(real.items[0].coins).toEqual([{ id: 'aaaa001', ticker: 'ORBIT', name: '$ORBIT', hue: expect.any(Number), coinScore: 78, coinBand: 'ok' }]);
    expect(real.items[1]).toMatchObject({ record: 'mixed', checked: 2, real: 0, avgTotal: 35 });
    expect(real.items[1].coins.map(c => c.id)).toEqual(['cccc001', 'dddd001']);
    expect(real.items[2]).toMatchObject({ record: 'serial', checked: 0, real: 0, avgTotal: null, coins: [] });

    const dead = (await viewer.get('/v1/deployers?sort=dead')).json<DeployersResponse>();
    expect(dead.items.map(d => d.address)).toEqual([D3_ADDR, D2_ADDR, D1_ADDR]);
    const launched = (await viewer.get('/v1/deployers?sort=launched&chain=all')).json<DeployersResponse>();
    expect(launched.items.map(d => d.address)).toEqual([D3_ADDR, D2_ADDR, D1_ADDR]);
    const sol = (await viewer.get('/v1/deployers?chain=sol')).json<DeployersResponse>();
    expect(sol.items.map(d => d.address)).toEqual([D1_ADDR, D3_ADDR]);
  });
});

describe('GET /v1/insights', () => {
  beforeAll(seedFeed);

  it('returns stats, since-check by verdict, most checked today and builders', async () => {
    // an old latest coin check outside the 30-day window
    const tOld = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca: 'OldMint', ticker: 'OLD', name: '$OLD', key: 'ca:sol:OldMint', lastPrice: '3' });
    await seedCheck(h.prisma, {
      targetId: tOld.id, shortId: 'old0001', totalScore: 90, narBand: 'real', coinScore: 90, coinBand: 'clean', priceAtCheck: '1',
      createdAt: new Date(Date.now() - 41 * 86400_000), finishedAt: new Date(Date.now() - 40 * 86400_000),
    });

    const r = (await viewer.get('/v1/insights')).json<InsightsDTO>();
    // DONE: A, E, B, B2, B3, C, D, private, old
    expect(r.stats.checked).toBe(9);
    // created today: A, E, B, B2, B3, C, running
    expect(r.stats.today).toBe(7);
    expect(r.stats.larpSince).toBe(-60);
    expect(r.sinceByVerdict).toEqual([
      { key: 'real', name: 'Real', n: 1, avg: 50 },
      { key: 'partly', name: 'Partly real', n: 1, avg: 10 },
      { key: 'larp', name: 'LARP', n: 1, avg: -60 },
    ]);
    expect(r.mostChecked.map(m => [m.id, m.checksToday])).toEqual([
      ['bbbb001', 3],
      ['aaaa001', 2],
      ['cccc001', 1],
      ['dddd001', 0],
      ['old0001', 0],
    ]);
    expect(r.mostChecked[0]).toMatchObject({ name: '@kairolabs', kind: 'post', checks: 50 });
    expect(r.builders).toEqual([
      { address: D1_ADDR, chain: 'sol', record: 'builder', checked: 1, real: 1 },
      { address: D2_ADDR, chain: 'base', record: 'mixed', checked: 2, real: 0 },
    ]);
  });
});

describe('GET /v1/live', () => {
  beforeAll(async () => resetState(h));

  it('lists queued and running public checks, newest first, at most 8', async () => {
    const c = new Client(h.app, '203.0.113.90');
    await c.get('/v1/me');
    const sid = c.sid(h.app)!;
    const t = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca: 'LiveMint', ticker: 'LUMA', name: '$LUMA', key: 'ca:sol:LiveMint' });
    const run = await seedCheck(h.prisma, {
      targetId: t.id, shortId: 'live001', status: 'RUNNING', requesterSid: sid,
      createdAt: new Date(Date.now() - 40_000), startedAt: new Date(Date.now() - 30_000),
    });
    await h.prisma.checkStep.createMany({
      data: [
        { checkId: run.id, idx: 0, tMs: 0, status: 'INFO', text: 'Contract on Solana: LiveMint' },
        { checkId: run.id, idx: 1, tMs: 3000, status: 'OK', text: 'Website from token metadata: luma.fi' },
        { checkId: run.id, idx: 2, tMs: 9000, status: 'INFO', text: 'Opening luma.fi in a clean browser' },
      ],
    });
    await h.redis.set(progressKey(run.id), '0.42');
    const ts = await seedTarget(h.prisma, { kind: 'SITE', domain: 'queued.xyz', name: 'queued.xyz', key: 'site:queued.xyz' });
    await seedCheck(h.prisma, { targetId: ts.id, shortId: 'live002', status: 'QUEUED', startedAt: null, createdAt: new Date(Date.now() - 5_000) });
    await seedCheck(h.prisma, { targetId: ts.id, shortId: 'live003', status: 'RUNNING', isPrivate: true, createdAt: new Date() });

    // a run the worker abandoned an hour ago is not "checking right now"
    await seedCheck(h.prisma, { targetId: ts.id, shortId: 'dead001', status: 'RUNNING', createdAt: new Date(Date.now() - 2_000), startedAt: new Date(Date.now() - 3600_000) });

    const r = (await c.get('/v1/live')).json<LiveResponse>();
    expect(r.items.map(i => i.id)).toEqual(['live002', 'live001']);
    const [queued, running] = r.items;
    expect(queued).toMatchObject({ kind: 'site', status: 'queued', startedAt: null, step: 0, stepsExpected: 10, progress: 0, lastText: null, mine: false });
    expect(queued.elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(running).toMatchObject({
      kind: 'coin', name: '$LUMA', ticker: 'LUMA', chain: 'sol', status: 'running', step: 3, stepsExpected: 14, progress: 0.42,
      lastText: 'Opening luma.fi in a clean browser', mine: true,
    });
    expect(running.elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(running.elapsedMs).toBeLessThan(40_000);

    for (let i = 0; i < 9; i++) {
      await seedCheck(h.prisma, { targetId: ts.id, shortId: `liveq0${i}`, status: 'QUEUED', createdAt: new Date(Date.now() - 1000 + i) });
    }
    const capped = (await c.get('/v1/live')).json<LiveResponse>();
    expect(capped.items).toHaveLength(8);
    expect(capped.items[0].id).toBe('liveq08');
  });
});

describe('GET /v1/bot/stats', () => {
  beforeAll(async () => resetState(h));

  it('counts replies today, the median reply time and distinct accounts', async () => {
    const t = await seedTarget(h.prisma);
    const mention = async (n: number, author: string, status: 'REPLIED' | 'IGNORED', createdAt: Date, replyAfterS: number | null) => {
      const check = replyAfterS == null ? null : await seedCheck(h.prisma, {
        targetId: t.id, shortId: `bot000${n}`, via: 'BOT', isLatest: false,
        createdAt, finishedAt: new Date(createdAt.getTime() + replyAfterS * 1000),
      });
      await h.prisma.botMention.create({
        data: { tweetId: `tw${n}`, authorId: author, authorHandle: author, text: '@ApeCheckBot real?', status, createdAt, checkId: check?.id },
      });
    };
    await mention(1, 'a1', 'REPLIED', today(min(10)), 180);
    await mention(2, 'a1', 'REPLIED', today(min(20)), 60);
    await mention(3, 'a2', 'REPLIED', today(min(30)), 300);
    await mention(4, 'a3', 'REPLIED', yesterday(), 999);
    await mention(5, 'a4', 'IGNORED', today(min(5)), null);
    const r = (await new Client(h.app).get('/v1/bot/stats')).json<BotStatsDTO>();
    expect(r).toEqual({ repliesToday: 3, medianReplySeconds: 180, accounts: 4 });
  });
});
