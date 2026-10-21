import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TUNING,
  progressKey,
  type BotStatsDTO,
  type CoinsResponse,
  type DeployersResponse,
  type FeedResponse,
  type InsightsDTO,
  type LiveResponse,
} from '@apecheck/core';
import { SNAPSHOT_MAX } from '../src/feed-snapshot';
import { Client, dbUrlInTimeZone, makeHarness, resetState, seedCheck, seedCoinFacts, seedTarget, type Harness } from './helpers';

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

let viewer: Client;
let ids: Record<string, string>;

/**
 * A: coin $ORBIT (sol)        total 80 real,   coin 78 ok,      checked 10, vol 500,  web, mine
 * B: post @kairolabs          total 30 llarp,  no coin,         checked 50,           bot
 * C: site helixdex.app (base) total 55 partly, coin 40 sketchy, checked 2,  vol 9000, bot
 * D: coin $NEXA (base)        total 15 larp,   coin 20 rigged,  checked 1,  vol null
 * not on the feed: an older check of A, a running check, a private check, a failed check
 * deployer wallets (CoinFacts.deployerAddress): A → D1 (sol); C (the coin the site found) and D → D2 (base)
 */
async function seedFeed() {
  await resetState(h);
  viewer = new Client(h.app, '203.0.113.33');
  await viewer.get('/v1/me');
  const sid = viewer.sid(h.app)!;

  const tA = await seedTarget(h.prisma, {
    kind: 'COIN', chain: 'SOL', ca: 'OrbitMint1111111111111111111111111111111111', ticker: 'ORBIT', name: '$ORBIT',
    key: 'ca:sol:OrbitMint1111111111111111111111111111111111', checkCount: 10, lastVol5m: '500', lastPrice: '1.5', lastMc: '2000000',
  });
  const tB = await seedTarget(h.prisma, { kind: 'POST', handle: 'kairolabs', name: '@kairolabs', key: 'post:1849', checkCount: 50 });
  const tC = await seedTarget(h.prisma, {
    kind: 'SITE', chain: 'BASE', ca: '0x3333333333333333333333333333333333333333', domain: 'helixdex.app', name: 'helixdex.app', key: 'site:helixdex.app',
    checkCount: 2, lastVol5m: '9000', lastPrice: '2.2',
  });
  const tD = await seedTarget(h.prisma, {
    kind: 'COIN', chain: 'BASE', ca: '0x4444444444444444444444444444444444444444', ticker: 'NEXA', name: '$NEXA',
    key: 'ca:base:0x4444444444444444444444444444444444444444', checkCount: 1, lastPrice: '0.4',
  });

  const A = await seedCheck(h.prisma, {
    targetId: tA.id, shortId: 'aaaa001', totalScore: 80, narScore: 82, narBand: 'real', coinScore: 78, coinBand: 'ok',
    requesterSid: sid, priceAtCheck: '1', createdAt: today(min(12)), finishedAt: ago(min(10)),
  });
  await seedCoinFacts(h.prisma, A.id, { deployerAddress: D1_ADDR, bundlePct: 2.5, top10Pct: 18, devHoldPct: 1.2, lpStatus: 'burned', authorities: 'Renounced' });
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
  await seedCoinFacts(h.prisma, C.id, { deployerAddress: D2_ADDR, sigBundle: 'WARN' });

  const D = await seedCheck(h.prisma, {
    targetId: tD.id, shortId: 'dddd001', totalScore: 15, narScore: 10, narBand: 'larp', coinScore: 20, coinBand: 'rigged',
    priceAtCheck: '1', createdAt: yesterday(), finishedAt: ago(min(30)),
  });
  await seedCoinFacts(h.prisma, D.id, { deployerAddress: D2_ADDR, sigDeployer: 'FAIL', lpStatus: 'unlocked' });

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

  it("finds and shows a coin's deployer wallet; the wallet is on the deployers page with that coin", async () => {
    const creator = '0x5555555555555555555555555555555555555555';
    const t = await seedTarget(h.prisma, { kind: 'COIN', chain: 'BASE', ca: '0x6666666666666666666666666666666666666666', ticker: 'NOHI', name: '$NOHI', key: 'ca:base:0x6666666666666666666666666666666666666666' });
    const c = await seedCheck(h.prisma, { targetId: t.id, shortId: 'nohi001', totalScore: 40, narScore: 40, narBand: 'partly', coinScore: 40, coinBand: 'sketchy', finishedAt: ago(min(50)) });
    await seedCoinFacts(h.prisma, c.id, { deployerAddress: creator, sigDeployer: 'WARN' });
    try {
      const hit = await feed('?q=0x55555');
      expect(order(hit)).toEqual(['nohi001']);
      expect(hit.items[0].deployer).toEqual({ address: creator, chain: 'base' });
      const coins = (await viewer.get('/v1/coins?q=0x55555')).json<CoinsResponse>();
      expect(coins.items[0].facts).toEqual({
        sig: { deployer: 'warn', bundle: 'ok', holders: 'ok', lp: 'ok', authorities: 'ok' },
        bundlePct: null, top10Pct: null, devHoldPct: null, lpLabel: 'Unknown', authorities: null, deployerAddress: creator,
      });
      // the deployers page lists the wallet with the coins ApeCheck has checked from it
      const deps = (await viewer.get('/v1/deployers')).json<DeployersResponse>();
      expect(deps.items.find(d => d.address === creator)).toMatchObject({ chain: 'base', checked: 1, coins: [{ id: 'nohi001', ticker: 'NOHI' }] });
      expect(await h.prisma.deployer.count()).toBe(0);
    } finally {
      await h.prisma.check.delete({ where: { id: c.id } });
      await h.prisma.target.delete({ where: { id: t.id } });
    }
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
      deployer: { address: D1_ADDR, chain: 'sol' },
    });
    const b = (await feed('?q=kairo')).items[0];
    expect(b).toMatchObject({ kind: 'post', title: 'Kairo', hasCoin: false, mc: null, since: null, spark: null, via: 'bot', by: 'solsleuth', mine: false, deployer: null });
    const anon = (await new Client(h.app).get('/v1/feed?q=orbit')).json<FeedResponse>();
    expect(anon.items[0].mine).toBe(false);
  });
});

describe('GET /v1/feed paging while the order changes', () => {
  /** six coins p1..p6, ranked p1 first on every tab (most checks, most 5m volume, best total, newest) */
  async function seedSix() {
    await resetState(h);
    const out: { targetId: string; checkId: string; shortId: string }[] = [];
    for (let i = 1; i <= 6; i++) {
      const t = await seedTarget(h.prisma, {
        kind: 'COIN', chain: 'SOL', ca: `PageMint${i}`, ticker: `PG${i}`, name: `$PG${i}`, key: `ca:sol:PageMint${i}`,
        checkCount: 70 - i * 10, lastVol5m: String(7000 - i * 1000),
      });
      const c = await seedCheck(h.prisma, {
        targetId: t.id, shortId: `pg0000${i}`, totalScore: 100 - i * 10, narScore: 100 - i * 10, narBand: 'likely', coinScore: 70, coinBand: 'ok',
        finishedAt: ago(min(i)),
      });
      out.push({ targetId: t.id, checkId: c.id, shortId: c.shortId });
    }
    return out;
  }
  const page = async (qs: string) => {
    const res = await new Client(h.app).get(`/v1/feed${qs}`);
    expect(res.statusCode).toBe(200);
    return res.json<FeedResponse>();
  };
  const expectEachOnce = (seen: string[], all: string[]) => {
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...all].sort());
  };

  it('"Most checked": a row that jumps up after page 1 is still on page 2, nothing repeats', async () => {
    const p = await seedSix();
    const p1 = await page('?tab=checked&limit=3');
    expect(order(p1)).toEqual(['pg00001', 'pg00002', 'pg00003']);
    // p5 gets a burst of requests (to the top), p1 falls to the bottom
    await h.prisma.target.update({ where: { id: p[4].targetId }, data: { checkCount: 100 } });
    await h.prisma.target.update({ where: { id: p[0].targetId }, data: { checkCount: 1 } });
    const p2 = await page(`?tab=checked&limit=3&cursor=${p1.nextCursor}`);
    expect(order(p2)).toEqual(['pg00004', 'pg00005', 'pg00006']);
    expect(p2.nextCursor).toBeNull();
    expect(p2.total).toBe(6);
    // the order is frozen, the rows are not
    expect(p2.items[1].checks).toBe(100);
    expectEachOnce([...order(p1), ...order(p2)], p.map(x => x.shortId));
  });

  it('"5m volume": rows reordered by a price tick between pages are neither skipped nor repeated', async () => {
    const p = await seedSix();
    const p1 = await page('?tab=vol&limit=2');
    expect(order(p1)).toEqual(['pg00001', 'pg00002']);
    await h.prisma.target.update({ where: { id: p[5].targetId }, data: { lastVol5m: '99000' } });
    await h.prisma.target.update({ where: { id: p[1].targetId }, data: { lastVol5m: '1' } });
    const p2 = await page(`?tab=vol&limit=2&cursor=${p1.nextCursor}`);
    await h.prisma.target.update({ where: { id: p[3].targetId }, data: { lastVol5m: null } });
    const p3 = await page(`?tab=vol&limit=2&cursor=${p2.nextCursor}`);
    expect([order(p2), order(p3)]).toEqual([['pg00003', 'pg00004'], ['pg00005', 'pg00006']]);
    expect(p3.nextCursor).toBeNull();
    expectEachOnce([...order(p1), ...order(p2), ...order(p3)], p.map(x => x.shortId));
  });

  it('"Most real": a re-check on page 1 does not shift a row out of page 2; a re-checked row shows its new verdict', async () => {
    const p = await seedSix();
    const p1 = await page('?tab=real&limit=3');
    expect(order(p1)).toEqual(['pg00001', 'pg00002', 'pg00003']);
    // p2 (shown) is re-checked and drops to the bottom; p5 (not shown yet) is re-checked too
    const recheck = async (i: number, shortId: string, totalScore: number) => {
      await h.prisma.check.update({ where: { id: p[i].checkId }, data: { isLatest: false } });
      await seedCheck(h.prisma, { targetId: p[i].targetId, shortId, totalScore, narScore: totalScore, narBand: 'larp', finishedAt: new Date() });
    };
    await recheck(1, 'pg00002b', 5);
    await recheck(4, 'pg00005b', 95);
    const p2 = await page(`?tab=real&limit=3&cursor=${p1.nextCursor}`);
    expect(order(p2)).toEqual(['pg00004', 'pg00005b', 'pg00006']);
    expect(p2.items[1]).toMatchObject({ total: 95, narBand: 'larp' });
  });

  it('falls back to the live order when the snapshot expired or belongs to other filters, and still reads old offset cursors', async () => {
    await seedSix();
    const p1 = await page('?tab=latest&limit=4');
    for (const key of await h.redis.keys('feed:snap:*')) await h.redis.del(key);
    expect(order(await page(`?tab=latest&limit=4&cursor=${p1.nextCursor}`))).toEqual(['pg00005', 'pg00006']);

    const p1b = await page('?tab=latest&limit=4');
    // same cursor, other filters: the live order of that query from the same position
    expect(order(await page(`?tab=least&limit=4&cursor=${p1b.nextCursor}`))).toEqual(['pg00002', 'pg00001']);

    const offset = Buffer.from('o:3').toString('base64url');
    const old = await page(`?tab=latest&limit=2&cursor=${offset}`);
    expect(order(old)).toEqual(['pg00004', 'pg00005']);
    expect(old.nextCursor).toEqual(expect.any(String));
    expect(order(await page(`?tab=latest&limit=2&cursor=${old.nextCursor}`))).toEqual(['pg00006']);
  });

  it(`pages the live order after the first ${SNAPSHOT_MAX} rows of a snapshot`, async () => {
    await resetState(h);
    const n = SNAPSHOT_MAX + 3;
    const targets = await h.prisma.target.createManyAndReturn({
      data: Array.from({ length: n }, (_, i) => ({ kind: 'SITE' as const, name: `bulk${i}.xyz`, domain: `bulk${i}.xyz`, key: `site:bulk${i}.xyz`, checkCount: 1 })),
      select: { id: true, key: true },
    });
    const base = Date.now() - 3600_000;
    await h.prisma.check.createMany({
      data: targets.map((t, i) => ({
        shortId: `bulk${String(i).padStart(4, '0')}`, targetId: t.id, targetRaw: t.key, status: 'DONE' as const, via: 'WEB' as const,
        isLatest: true, totalScore: 50, createdAt: new Date(base), startedAt: new Date(base), finishedAt: new Date(base + i * 1000),
      })),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: FeedResponse = await page(`?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.total).toBe(n);
      seen.push(...order(r));
      cursor = r.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(6);
    expect(seen).toHaveLength(n);
    expect(new Set(seen).size).toBe(n);
    expect(seen[0]).toBe(`bulk${String(n - 1).padStart(4, '0')}`);
    expect(seen[n - 1]).toBe('bulk0000');
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
      bundlePct: 2.5, top10Pct: 18, devHoldPct: 1.2, lpLabel: 'Burned', authorities: 'Renounced', deployerAddress: D1_ADDR,
    });
    expect(all.items[2].facts).toMatchObject({ sig: { deployer: 'fail' }, lpLabel: 'Unlocked', deployerAddress: D2_ADDR });
    expect(order((await viewer.get('/v1/coins?tab=sketchy')).json<CoinsResponse>())).toEqual(['cccc001']);
    expect(order((await viewer.get('/v1/coins?tab=all&chain=sol')).json<CoinsResponse>())).toEqual(['aaaa001']);
    expect(order((await viewer.get('/v1/coins?chain=base')).json<CoinsResponse>())).toEqual(['cccc001', 'dddd001']);
    expect(order((await viewer.get('/v1/coins?q=%24nexa')).json<CoinsResponse>())).toEqual(['dddd001']);
    expect(order((await viewer.get(`/v1/coins?q=${D1_ADDR.slice(0, 8)}`)).json<CoinsResponse>())).toEqual(['aaaa001']);
  });
});

describe('GET /v1/deployers', () => {
  beforeAll(seedFeed);

  it("lists every wallet named by a public coin check, with the coins ApeCheck has checked from it, and sorts them", async () => {
    const real = (await viewer.get('/v1/deployers')).json<DeployersResponse>();
    expect(real.items.map(d => d.address)).toEqual([D1_ADDR, D2_ADDR]);
    const a = await h.prisma.check.findUniqueOrThrow({ where: { shortId: 'aaaa001' } });
    expect(real.items[0]).toEqual({
      chain: 'sol', address: D1_ADDR, checked: 1, real: 1, avgTotal: 80, lastChecked: a.finishedAt!.toISOString(),
      coins: [{ id: 'aaaa001', ticker: 'ORBIT', name: '$ORBIT', hue: expect.any(Number), logo: null, coinScore: 78, coinBand: 'ok' }],
    });
    // the coin the helixdex.app site check found counts for its wallet like a coin check
    expect(real.items[1]).toMatchObject({ chain: 'base', checked: 2, real: 0, avgTotal: 35 });
    expect(real.items[1].coins.map(c => c.id)).toEqual(['cccc001', 'dddd001']);
    expect(real.items.every(d => !('record' in d) && !('launched' in d) && !('dead' in d))).toBe(true);

    const checked = (await viewer.get('/v1/deployers?sort=checked')).json<DeployersResponse>();
    expect(checked.items.map(d => d.address)).toEqual([D2_ADDR, D1_ADDR]);
    // C finished 5 minutes ago, A 10
    const recent = (await viewer.get('/v1/deployers?sort=recent')).json<DeployersResponse>();
    expect(recent.items.map(d => d.address)).toEqual([D2_ADDR, D1_ADDR]);
    // links from before: the launch-record sorts read as "checked"
    for (const sort of ['dead', 'launched']) {
      const res = await viewer.get(`/v1/deployers?sort=${sort}&chain=all`);
      expect(res.statusCode).toBe(200);
      expect(res.json<DeployersResponse>().items.map(d => d.address)).toEqual([D2_ADDR, D1_ADDR]);
    }
    expect((await viewer.get('/v1/deployers?sort=hot')).statusCode).toBe(400);
    const sol = (await viewer.get('/v1/deployers?chain=sol')).json<DeployersResponse>();
    expect(sol.items.map(d => d.address)).toEqual([D1_ADDR]);
  });
});

describe('deployers named only by private checks (M3)', () => {
  beforeAll(seedFeed);

  it('are never listed on /v1/deployers or among the insights builders; a public check of their coin makes them public', async () => {
    const PRIV = 'PrivDeployer111111111111111111111111111111111'.slice(0, 44);
    const maxUser = await h.prisma.user.create({ data: { solAddress: 'MaxUserWa11et1111111111111111111111111111111', tier: 'MAX' } });
    const ca = 'PrivMint11111111111111111111111111111111111';
    const tP = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca, ticker: 'PRIV', name: '$PRIV', key: `ca:sol:${ca}`, checkCount: 0 });
    // a Max user's private check: the worker never makes it isLatest
    const p = await seedCheck(h.prisma, {
      targetId: tP.id, shortId: 'priv001', isPrivate: true, isLatest: false, requesterId: maxUser.id, totalScore: 90, coinScore: 90, coinBand: 'clean',
    });
    await seedCoinFacts(h.prisma, p.id, { deployerAddress: PRIV });

    const anon = new Client(h.app, '203.0.113.77');
    for (const c of [anon, viewer]) {
      for (const qs of ['', '?sort=checked', '?sort=recent', '?chain=sol']) {
        const listed = (await c.get(`/v1/deployers${qs}`)).json<DeployersResponse>().items.map(d => d.address);
        expect(listed, qs).not.toContain(PRIV);
        expect(listed, qs).toContain(D1_ADDR);
      }
      expect((await c.get('/v1/insights')).json<InsightsDTO>().builders.map(b => b.address)).not.toContain(PRIV);
    }

    // the same coin checked publicly afterwards: its deployer is now public, with that coin
    const q = await seedCheck(h.prisma, { targetId: tP.id, shortId: 'pub0001', totalScore: 70, coinScore: 72, coinBand: 'ok' });
    await seedCoinFacts(h.prisma, q.id, { deployerAddress: PRIV });
    const now = (await anon.get('/v1/deployers')).json<DeployersResponse>().items.find(d => d.address === PRIV);
    expect(now).toMatchObject({ chain: 'sol', checked: 1, real: 1 });
    expect(now!.coins.map(c => c.id)).toEqual(['pub0001']);
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
    // DONE: A, E, B, B2, B3, C, D, old (the private check stays out of every public number, M3)
    expect(r.stats.checked).toBe(8);
    // DONE and finished today: A, E, B, B2, B3, C, D (created yesterday) (minutes ago, so in the first
    // hour of a UTC day some of them finished yesterday). Not the running check started today, not the private one.
    const finishedMinAgo = [10, 45, 20, 39, 59, 5, 30];
    expect(r.stats.today).toBe(finishedMinAgo.filter(m => Date.now() - min(m) >= startOfToday().getTime()).length);
    expect(r.stats.today).toBeLessThanOrEqual(r.stats.checked);
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
    // a deployer with no coin that checked real is no builder
    expect(r.builders).toEqual([{ address: D1_ADDR, chain: 'sol', checked: 1, real: 1 }]);
  });
});

describe('GET /v1/insights stats', () => {
  it('counts "today" from the same finished checks as "checked", so it never exceeds it', async () => {
    await resetState(h);
    const t = await seedTarget(h.prisma);
    const t2 = await seedTarget(h.prisma);
    // finished today
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'tday001', isLatest: false, createdAt: today(min(12)), finishedAt: today(min(10)) });
    // requested yesterday, finished today
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'tday002', createdAt: yesterday(), finishedAt: today(min(5)) });
    // finished yesterday: all time only
    await seedCheck(h.prisma, { targetId: t2.id, shortId: 'tday003', createdAt: yesterday(), finishedAt: yesterday() });
    // private and finished today: in neither number (private checks stay out of public stats, M3)
    await seedCheck(h.prisma, { targetId: t2.id, shortId: 'tday004', isPrivate: true, isLatest: false, createdAt: today(min(4)), finishedAt: today(min(3)) });
    // started today but no verdict: in neither number
    await seedCheck(h.prisma, { targetId: t2.id, shortId: 'tday005', status: 'RUNNING', createdAt: today(min(2)) });
    await seedCheck(h.prisma, { targetId: t2.id, shortId: 'tday006', status: 'QUEUED', startedAt: null, createdAt: today(min(1)) });
    await seedCheck(h.prisma, { targetId: t2.id, shortId: 'tday007', status: 'FAILED', isLatest: false, createdAt: today(min(3)), finishedAt: today(min(2)) });

    const r = (await new Client(h.app).get('/v1/insights')).json<InsightsDTO>();
    expect(r.stats).toMatchObject({ checked: 3, today: 2 });
  });
});

describe('GET /v1/insights on a Postgres session that is not on UTC', () => {
  // timestamps are stored as UTC wall-clock time (timestamp without time zone); a server whose Postgres runs in
  // its OS zone must not move the 30-day "Since check, by verdict" window by that zone's offset
  it.each(['Asia/Tokyo', 'America/New_York'])('keeps the 30-day window in UTC (%s)', async tz => {
    const hz = await makeHarness({ DATABASE_URL: dbUrlInTimeZone(tz) });
    try {
      await resetState(hz);
      expect((await hz.prisma.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`)[0].TimeZone).toBe(tz);
      const edge = Date.now() - TUNING.sinceWindowDays * 86400_000;
      const coin = async (n: number, narBand: string, finishedAt: Date) => {
        const t = await seedTarget(hz.prisma, {
          kind: 'COIN', chain: 'SOL', ca: `TzMint${n}`, ticker: `TZ${n}`, name: `$TZ${n}`, key: `ca:sol:TzMint${n}`, lastPrice: '2',
        });
        await seedCheck(hz.prisma, {
          targetId: t.id, shortId: `tzon00${n}`, narScore: 50, narBand, totalScore: 50, priceAtCheck: '1',
          createdAt: new Date(finishedAt.getTime() - 60_000), finishedAt,
        });
      };
      // 2 h inside and 2 h outside the window: a shift of more than 2 h (Tokyo +9, New York -4) would swap them
      await coin(1, 'partly', new Date(edge + 2 * 3600_000));
      await coin(2, 'larp', new Date(edge - 2 * 3600_000));
      const r = (await new Client(hz.app).get('/v1/insights')).json<InsightsDTO>();
      expect(r.sinceByVerdict).toEqual([{ key: 'partly', name: 'Partly real', n: 1, avg: 100 }]);
    } finally {
      await hz.close();
    }
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
    // a check an older worker was running: its newest step reads in ApeCheck's own words
    const old = await seedCheck(h.prisma, {
      targetId: t.id, shortId: 'live004', status: 'RUNNING', createdAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 50_000),
    });
    await h.prisma.checkStep.create({
      data: { checkId: old.id, idx: 0, tMs: 0, status: 'WARN', text: 'WhaleFlow unavailable, holder share unknown (Solana RPC unavailable)', source: 'WhaleFlow' },
    });
    const ts = await seedTarget(h.prisma, { kind: 'SITE', domain: 'queued.xyz', name: 'queued.xyz', key: 'site:queued.xyz' });
    await seedCheck(h.prisma, { targetId: ts.id, shortId: 'live002', status: 'QUEUED', startedAt: null, createdAt: new Date(Date.now() - 5_000) });
    await seedCheck(h.prisma, { targetId: ts.id, shortId: 'live003', status: 'RUNNING', isPrivate: true, createdAt: new Date() });

    // a run the worker abandoned an hour ago is not "checking right now"
    await seedCheck(h.prisma, { targetId: ts.id, shortId: 'dead001', status: 'RUNNING', createdAt: new Date(Date.now() - 2_000), startedAt: new Date(Date.now() - 3600_000) });

    const r = (await c.get('/v1/live')).json<LiveResponse>();
    expect(r.items.map(i => i.id)).toEqual(['live002', 'live001', 'live004']);
    expect(r.items[2].lastText).toBe('Holder share: not checked (Solana RPC unavailable)');
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
    expect(JSON.stringify(r)).not.toMatch(/whaleflow/i);
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
        data: { tweetId: `tw${n}`, authorId: author, authorHandle: author, text: '@ApeCheckBot real?', tagged: true, status, createdAt, checkId: check?.id },
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

  it('prefers the stored reply time (repliedAt) when the bot recorded one', async () => {
    await resetState(h);
    const t = await seedTarget(h.prisma);
    const createdAt = today(min(30));
    const check = await seedCheck(h.prisma, { targetId: t.id, shortId: 'botr001', via: 'BOT', isLatest: false, createdAt, finishedAt: new Date(createdAt.getTime() + 100_000) });
    await h.prisma.botMention.create({
      data: { tweetId: 'twr1', authorId: 'r1', authorHandle: 'r1', text: '@ApeCheckBot?', tagged: true, status: 'REPLIED', createdAt, checkId: check.id, repliedAt: new Date(createdAt.getTime() + 130_000) },
    });
    // mentioned yesterday, answered today: counts as a reply today
    const y = yesterday();
    await h.prisma.botMention.create({
      data: { tweetId: 'twr2', authorId: 'r2', authorHandle: 'r2', text: '@ApeCheckBot?', tagged: true, status: 'REPLIED', createdAt: y, repliedAt: new Date(Math.max(Date.now() - 1000, y.getTime() + 1000)) },
    });
    // the bot's own post mentioning itself is stored (ignored as "self") but is not an account that tagged it
    await h.prisma.botMention.create({
      data: { tweetId: 'twr3', authorId: 'bot', authorHandle: 'ApeCheckBot', text: '@ApeCheckBot', status: 'IGNORED', kind: 'ignored', ignoreReason: 'self' },
    });
    const r = (await new Client(h.app).get('/v1/bot/stats')).json<BotStatsDTO>();
    expect(r.repliesToday).toBe(2);
    expect(r.accounts).toBe(2);
    expect(r.medianReplySeconds).toBeGreaterThanOrEqual(130);
  });

  it('counts only accounts that typed the handle: not thread chatter, untagged follow-ups or retweets of a tag', async () => {
    await resetState(h);
    type Extra = { text: string; tagged?: boolean; status?: 'REPLIED' | 'IGNORED'; kind?: string; ignoreReason?: string; isFollowUp?: boolean };
    const row = (tweetId: string, authorId: string, extra: Extra) =>
      h.prisma.botMention.create({ data: { tweetId, authorId, authorHandle: authorId, status: 'IGNORED', kind: 'ignored', ...extra } });
    // the one real tag (the worker stores tagged from what the author typed)
    await row('twt1', 'tagger', { text: '@ApeCheckBot is this real? @kairolabs', tagged: true, status: 'REPLIED', kind: 'check' });
    // ten people arguing under the bot's reply: the bot is only in X's "Replying to" prefix
    for (let i = 0; i < 10; i++) await row(`twt-chat${i}`, `chatter${i}`, { text: 'nah this is fake', ignoreReason: 'not_tagged' });
    // a retweet of someone else's tag
    await row('twt-rt', 'retweeter', { text: 'RT @tagger: @ApeCheckBot is this real?', ignoreReason: 'retweet' });
    // a reply to the bot's verdict that never typed the handle (rule 2), answered or pointed at the report
    await row('twt-fu1', 'follower1', { text: 'why so low?', kind: 'followup', status: 'REPLIED', isFollowUp: true });
    await row('twt-fu2', 'follower2', { text: 'and the team?', kind: 'ignored', ignoreReason: 'pointer_already_sent', isFollowUp: true });
    // the bot's own post
    await row('twt-self', 'bot', { text: '@ApeCheckBot', ignoreReason: 'self' });
    // a tag that was not answered (account too young, or over the hourly limit) is still an account that tagged it
    await row('twt-young', 'newbie', { text: '@apecheckbot real?', tagged: true, ignoreReason: 'young_account' });
    const r = (await new Client(h.app).get('/v1/bot/stats')).json<BotStatsDTO>();
    expect(r.accounts).toBe(2);
  });
});
