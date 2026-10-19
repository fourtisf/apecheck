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
    // first check 40 days ago, re-checked yesterday: tracking still follows the first check
    const rechecked = await coin(d, 40 * DAY, 2 * DAY, 1 * DAY);
    const site = await prisma.target.create({ data: { key: 'site:no-coin.xyz', kind: 'SITE', name: 'no-coin.xyz', domain: 'no-coin.xyz' } });
    await prisma.check.create({ data: { shortId: 'site001', targetId: site.id, targetRaw: 'no-coin.xyz', status: 'DONE', finishedAt: ago(HOUR) } });

    const env = testEnv();
    const sources = fakeSources(env, {
      dexTokens: Object.fromEntries([a, b, c, d].map(x => [x, dexInfo({ chain: 'base', address: x, priceUsd: 0.5, mc: 500_000, vol5m: 1200, ch24: -4.2 })])),
    });
    const res = await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger(), batchSize: 1 }, now);
    expect(res).toEqual({ tracked: 2, due: 1, written: 1 });
    expect(sources.calls.filter(x => x.startsWith('dex.tokens'))).toEqual(['dex.tokens base 1']);

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
    for (const x of [fresh, old, rechecked]) expect(await prisma.pricePoint.count({ where: { targetId: x.id } })).toBe(1);
  });

  it('a coin DexScreener no longer knows is skipped without failing the tick', async () => {
    await coin('0xe000000000000000000000000000000000000005', HOUR, null);
    const env = testEnv();
    const res = await runPriceTick({ prisma, dex: fakeSources(env).dex, log: memoryLogger() }, now);
    expect(res).toEqual({ tracked: 1, due: 1, written: 0 });
  });
});
