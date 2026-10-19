/** worker-prices: the 15 min / hourly / daily cadence and one tick against the test database. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLogger } from '../src/log';
import { isDue, priceInterval } from '../src/prices/schedule';
import { runPriceTick } from '../src/prices/tick';
import { dexInfo, fakeSources } from './fakes';
import { prisma, resetDb, testEnv } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.parse('2026-10-19T12:00:00Z');
const ago = (ms: number) => new Date(now - ms);

describe('due schedule', () => {
  it('15 minutes for the first day, hourly to day 7, daily to day 30, then stop', () => {
    expect(priceInterval(ago(2 * HOUR), now)).toBe(15 * MIN);
    expect(priceInterval(ago(3 * DAY), now)).toBe(HOUR);
    expect(priceInterval(ago(20 * DAY), now)).toBe(DAY);
    expect(priceInterval(ago(31 * DAY), now)).toBeNull();
  });
  it('due when the newest point is one interval old (one minute of slack)', () => {
    expect(isDue(ago(2 * HOUR), null, now)).toBe(true);
    expect(isDue(ago(2 * HOUR), ago(10 * MIN), now)).toBe(false);
    expect(isDue(ago(2 * HOUR), ago(15 * MIN), now)).toBe(true);
    expect(isDue(ago(2 * HOUR), ago(14.5 * MIN), now)).toBe(true);
    expect(isDue(ago(2 * DAY), ago(30 * MIN), now)).toBe(false);
    expect(isDue(ago(2 * DAY), ago(61 * MIN), now)).toBe(true);
    expect(isDue(ago(10 * DAY), ago(23 * HOUR), now)).toBe(false);
    expect(isDue(ago(10 * DAY), ago(25 * HOUR), now)).toBe(true);
    expect(isDue(ago(31 * DAY), null, now)).toBe(false);
  });
});

describe('price tick', () => {
  beforeEach(() => resetDb());
  afterAll(() => prisma.$disconnect());

  async function coin(addr: string, firstCheckAgo: number, lastPointAgo: number | null, extraCheckAgo?: number) {
    const t = await prisma.target.create({ data: { key: `ca:base:${addr}`, kind: 'COIN', chain: 'BASE', ca: addr, name: addr.slice(0, 6) } });
    let i = 0;
    for (const a of [firstCheckAgo, extraCheckAgo].filter((x): x is number => x != null)) {
      await prisma.check.create({ data: { shortId: `${addr.slice(2, 8)}${i++}`, targetId: t.id, targetRaw: addr, status: 'DONE', finishedAt: ago(a) } });
    }
    if (lastPointAgo != null) await prisma.pricePoint.create({ data: { targetId: t.id, ts: ago(lastPointAgo), price: 1 } });
    return t;
  }

  it('writes a point for each due coin and refreshes the target; skips coins not due or past 30 days', async () => {
    const a = '0xa000000000000000000000000000000000000001';
    const b = '0xb000000000000000000000000000000000000002';
    const c = '0xc000000000000000000000000000000000000003';
    const d = '0xd000000000000000000000000000000000000004';
    const due = await coin(a, 2 * HOUR, 20 * MIN);
    const fresh = await coin(b, 2 * HOUR, 5 * MIN);
    const old = await coin(c, 40 * DAY, 2 * DAY);
    // first check 40 days ago, re-checked yesterday: tracked again, hourly from the re-check (last point 2 days old: due)
    const rechecked = await coin(d, 40 * DAY, 2 * DAY, 1 * DAY);
    const site = await prisma.target.create({ data: { key: 'site:no-coin.xyz', kind: 'SITE', name: 'no-coin.xyz', domain: 'no-coin.xyz' } });
    await prisma.check.create({ data: { shortId: 'site001', targetId: site.id, targetRaw: 'no-coin.xyz', status: 'DONE', finishedAt: ago(HOUR) } });

    const env = testEnv();
    const sources = fakeSources(env, {
      dexTokens: Object.fromEntries([a, b, c, d].map(x => [x, dexInfo({ chain: 'base', address: x, priceUsd: 0.5, mc: 500_000, vol5m: 1200, ch24: -4.2 })])),
    });
    const res = await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger(), batchSize: 1 }, now);
    expect(res).toEqual({ tracked: 3, due: 2, written: 2 });
    expect(sources.calls.filter(x => x.startsWith('dex.tokens'))).toEqual(['dex.tokens base 1', 'dex.tokens base 1']);

    const points = await prisma.pricePoint.findMany({ where: { targetId: due.id }, orderBy: { ts: 'asc' } });
    expect(points).toHaveLength(2);
    expect(points[1].ts.getTime()).toBe(now);
    expect(Number(points[1].price)).toBe(0.5);
    expect(Number(points[1].mc)).toBe(500_000);
    const t = await prisma.target.findUniqueOrThrow({ where: { id: due.id } });
    expect(Number(t.lastPrice)).toBe(0.5);
    expect(Number(t.lastVol5m)).toBe(1200);
    expect(t.lastCh24).toBe(-4.2);
    expect(t.priceUpdatedAt?.getTime()).toBe(now);
    for (const x of [fresh, old]) expect(await prisma.pricePoint.count({ where: { targetId: x.id } })).toBe(1);
    expect(await prisma.pricePoint.count({ where: { targetId: rechecked.id } })).toBe(2);
  });

  it('a re-check restarts the schedule: first check 40 days ago, re-checked a minute ago → a point every 15 minutes', async () => {
    const e = '0xe100000000000000000000000000000000000006';
    const t = await coin(e, 40 * DAY, null, 1 * MIN);
    // saveStage set lastPrice to the re-check's priceAtCheck
    await prisma.target.update({ where: { id: t.id }, data: { lastPrice: 1 } });
    const env = testEnv();
    const sources = fakeSources(env, { dexTokens: { [e]: dexInfo({ chain: 'base', address: e, priceUsd: 2 }) } });
    // a tick 20 minutes after the re-check
    const later = now + 20 * MIN;
    expect(await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger() }, later)).toEqual({ tracked: 1, due: 1, written: 1 });
    expect(Number((await prisma.target.findUniqueOrThrow({ where: { id: t.id } })).lastPrice)).toBe(2);
    // 10 minutes later it is not due yet (15-minute cadence of the re-check's first day), 20 minutes later it is
    expect((await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger() }, later + 10 * MIN)).due).toBe(0);
    expect((await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger() }, later + 15 * MIN)).due).toBe(1);
  });

  it('a re-check within the 30 days uses its own cadence, not the first check\'s', async () => {
    const f = '0xf100000000000000000000000000000000000007';
    // first check 10 days ago (daily cadence), re-checked 2 h ago, last point 20 minutes ago: due on the 15-minute cadence
    await coin(f, 10 * DAY, 20 * MIN, 2 * HOUR);
    const env = testEnv();
    const sources = fakeSources(env, { dexTokens: { [f]: dexInfo({ chain: 'base', address: f, priceUsd: 0.7 }) } });
    expect(await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger() }, now)).toEqual({ tracked: 1, due: 1, written: 1 });
  });

  it('a check that got no price (DexScreener down) takes the first price read within 30 minutes as its price at check', async () => {
    const g = '0xa200000000000000000000000000000000000008';
    const h2 = '0xa300000000000000000000000000000000000009';
    const fresh = await coin(g, 10 * MIN, null);
    const late = await coin(h2, 45 * MIN, null);
    const env = testEnv();
    const sources = fakeSources(env, {
      dexTokens: {
        [g]: dexInfo({ chain: 'base', address: g, priceUsd: 0.25, mc: 250_000 }),
        [h2]: dexInfo({ chain: 'base', address: h2, priceUsd: 0.5, mc: 500_000 }),
      },
    });
    expect(await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger() }, now)).toEqual({ tracked: 2, due: 2, written: 2 });
    const a = await prisma.check.findFirstOrThrow({ where: { targetId: fresh.id } });
    expect(Number(a.priceAtCheck)).toBe(0.25);
    expect(Number(a.mcAtCheck)).toBe(250_000);
    // 45 minutes after the check is no longer "at check": left empty
    expect((await prisma.check.findFirstOrThrow({ where: { targetId: late.id } })).priceAtCheck).toBeNull();
    // a price at check that exists is never replaced
    await prisma.check.update({ where: { id: a.id }, data: { priceAtCheck: 0.2 } });
    await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger() }, now + 16 * MIN);
    expect(Number((await prisma.check.findUniqueOrThrow({ where: { id: a.id } })).priceAtCheck)).toBe(0.2);
  });

  it("a private (Max) check never moves a public coin's schedule; a coin only private checks looked at is tracked on them", async () => {
    const pubCa = '0xa400000000000000000000000000000000000010';
    const privCa = '0xa500000000000000000000000000000000000011';
    // public check 10 days ago (daily cadence), last point 3 h ago; a private check of it 10 minutes ago
    const pub = await coin(pubCa, 10 * DAY, 3 * HOUR);
    const privOfPub = await prisma.check.create({
      data: { shortId: 'priv0001', targetId: pub.id, targetRaw: pubCa, status: 'DONE', isPrivate: true, finishedAt: ago(10 * MIN) },
    });
    // a coin only a private check looked at, 10 minutes ago (15-minute cadence, no point yet)
    const onlyPriv = await prisma.target.create({ data: { key: `ca:base:${privCa}`, kind: 'COIN', chain: 'BASE', ca: privCa, name: 'priv' } });
    const priv = await prisma.check.create({ data: { shortId: 'priv0002', targetId: onlyPriv.id, targetRaw: privCa, status: 'DONE', isPrivate: true, finishedAt: ago(10 * MIN) } });
    const env = testEnv();
    const sources = fakeSources(env, {
      dexTokens: Object.fromEntries([pubCa, privCa].map(x => [x, dexInfo({ chain: 'base', address: x, priceUsd: 0.3, mc: 300_000 })])),
    });
    // the public coin is not due (daily cadence of its public check), whatever the private check did
    expect(await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger() }, now)).toEqual({ tracked: 2, due: 1, written: 1 });
    expect(await prisma.pricePoint.count({ where: { targetId: pub.id } })).toBe(1);
    expect(await prisma.pricePoint.count({ where: { targetId: onlyPriv.id } })).toBe(1);
    // the private-only coin's check gets its price at check; the private check of the public coin is not its anchor
    expect(Number((await prisma.check.findUniqueOrThrow({ where: { id: priv.id } })).priceAtCheck)).toBe(0.3);
    expect((await prisma.check.findUniqueOrThrow({ where: { id: privOfPub.id } })).priceAtCheck).toBeNull();
  });

  it('a coin DexScreener no longer knows is skipped without failing the tick', async () => {
    await coin('0xe000000000000000000000000000000000000005', HOUR, null);
    const env = testEnv();
    const res = await runPriceTick({ prisma, dex: fakeSources(env).dex, log: memoryLogger() }, now);
    expect(res).toEqual({ tracked: 1, due: 1, written: 0 });
  });
});
