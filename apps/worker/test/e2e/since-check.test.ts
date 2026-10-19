/**
 * "Since check" end to end (HANDOFF §10) with fake DexScreener data: two coin checks run through the real queue and
 * pipeline (Stage F stores priceAtCheck and the first PricePoint), worker-prices' tick runs on its schedule over two
 * simulated days while the fake prices move (every 15 min for the first day, then hourly), and the real API — built
 * from apps/api against this test database — serves what the site shows: the report's "Price since check" number
 * and chart series, the feed's since % and sparkline, and the "Since check, by verdict" insight card.
 *
 * The API is loaded from its source at run time (not type-checked here), so this file only depends on its HTTP
 * contract: GET /v1/checks/:id, GET /v1/feed, GET /v1/insights.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CHECK_JOB_OPTIONS, QUEUES, TUNING, type CheckJob, type CheckReportDTO, type FeedResponse, type InsightsDTO } from '@apecheck/core';
import { memoryLogger } from '../../src/log';
import { runPriceTick } from '../../src/prices/tick';
import { PRICE_TICK_MS } from '../../src/prices/schedule';
import { startCheckWorker, type CheckWorkerHandle } from '../../src/worker';
import { dexInfo, fakeSources, type FakeSources } from '../fakes';
import { createCheck, prisma, resetDb, testEnv } from '../helpers';

const UP = '0x5100000000000000000000000000000000000001';
const DOWN = '0x5200000000000000000000000000000000000002';
const MIN = 60_000;
const HOUR = 60 * MIN;

let worker: CheckWorkerHandle;
let queue: Queue<CheckJob>;
let conn: Redis;
let sources: FakeSources;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let api: any;

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  await resetDb();
  conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  await conn.flushdb();
  const env = testEnv();
  sources = fakeSources(env, {
    evmChains: { [UP]: 'base', [DOWN]: 'base' },
    dexTokens: {
      [UP]: dexInfo({ chain: 'base', address: UP, priceUsd: 0.01, mc: 1_000_000, symbol: 'UPC', name: 'Up coin' }),
      [DOWN]: dexInfo({ chain: 'base', address: DOWN, priceUsd: 0.02, mc: 2_000_000, symbol: 'DWN', name: 'Down coin' }),
    },
  });
  worker = await startCheckWorker({ env, sources, log: memoryLogger(), recover: false, fetchCard: async () => null });
  queue = new Queue<CheckJob>(QUEUES.checks, { connection: conn });
  await queue.obliterate({ force: true }).catch(() => undefined);

  const apiServer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../api/src/server.ts');
  const { buildServer } = await import(pathToFileURL(apiServer).href);
  api = await buildServer({ env: { ...env, LOG_LEVEL: 'silent', APP_URL: 'http://app.test' }, prisma, logger: false });
  await api.ready();
});

afterAll(async () => {
  await api?.close();
  await worker?.close(1000);
  await queue?.close();
  await conn?.quit();
  await prisma.$disconnect();
});

const get = async <T>(url: string): Promise<T> => {
  const res = await api.inject({ method: 'GET', url });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
};

it('price points on the 15 min / 1 h schedule feed the report chart, the feed and the insight card', async () => {
  // two coin checks through the real queue and pipeline
  const ids: string[] = [];
  for (const ca of [UP, DOWN]) {
    const c = await createCheck(ca);
    await queue.add('check', { checkId: c.id }, { jobId: c.id, ...CHECK_JOB_OPTIONS });
    ids.push(c.id);
  }
  const checks = await until('both checks', async () => {
    const rows = await prisma.check.findMany({ where: { id: { in: ids } }, include: { target: true } });
    return rows.every(r => r.status === 'DONE') ? rows : null;
  });
  const up = checks.find(c => c.target.ca === UP)!;
  const down = checks.find(c => c.target.ca === DOWN)!;
  expect(Number(up.priceAtCheck)).toBe(0.01);
  expect(Number(up.mcAtCheck)).toBe(1_000_000);
  expect(Number(down.priceAtCheck)).toBe(0.02);
  // Stage F's first point
  expect(await prisma.pricePoint.count({ where: { targetId: up.targetId } })).toBe(1);

  // two days of worker-prices ticks (every PRICE_TICK_MS) while UP doubles and DOWN halves, linearly
  const t0 = Math.max(up.finishedAt!.getTime(), down.finishedAt!.getTime());
  const span = 48 * HOUR;
  for (let t = t0 + PRICE_TICK_MS; t <= t0 + span; t += PRICE_TICK_MS) {
    const f = (t - t0) / span;
    sources.data.dexTokens![UP.toLowerCase()] = dexInfo({ chain: 'base', address: UP, priceUsd: 0.01 * (1 + f), mc: 1_000_000 * (1 + f), ch24: 10 });
    sources.data.dexTokens![DOWN.toLowerCase()] = dexInfo({ chain: 'base', address: DOWN, priceUsd: 0.02 * (1 - f / 2), mc: 2_000_000 * (1 - f / 2), ch24: -5 });
    await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger() }, t);
  }

  // the schedule: every 15 minutes for the first 24 h, hourly after that (one minute of slack on a 5-minute tick)
  const pts = await prisma.pricePoint.findMany({ where: { targetId: up.targetId }, orderBy: { ts: 'asc' } });
  const gaps = pts.slice(1).map((p, i) => (p.ts.getTime() - pts[i].ts.getTime()) / MIN);
  const firstDay = pts.filter(p => p.ts.getTime() - up.finishedAt!.getTime() <= 24 * HOUR).length;
  expect(firstDay).toBeGreaterThanOrEqual(95);
  expect(firstDay).toBeLessThanOrEqual(98);
  expect(gaps.slice(0, 90).every(g => g >= 15 && g <= 20)).toBe(true);
  expect(gaps.slice(-20).every(g => g >= 60 && g <= 65)).toBe(true);
  // since % = latest price vs the price at check
  const last = async (targetId: string) => Number((await prisma.target.findUniqueOrThrow({ where: { id: targetId } })).lastPrice);
  const upSince = (await last(up.targetId) / 0.01 - 1) * 100;
  const downSince = (await last(down.targetId) / 0.02 - 1) * 100;
  expect(upSince).toBeGreaterThan(98);
  expect(downSince).toBeLessThan(-48);

  // the report: "Price since check" and its chart
  const report = await get<CheckReportDTO>(`/v1/checks/${up.shortId}`);
  expect(report.market).toBeTruthy();
  const m = report.market!;
  expect(m.since).toBeCloseTo(upSince, 1);
  expect(m.series!.length).toBe(TUNING.sparkPoints);
  expect(m.series![0]).toEqual({ t: up.finishedAt!.toISOString(), pct: 0 });
  expect(m.series!.at(-1)!.pct).toBeCloseTo(upSince, 1);
  // oldest first, rising
  const s = m.series!;
  expect(s.every((p, i) => i === 0 || (Date.parse(p.t) > Date.parse(s[i - 1].t) && p.pct >= s[i - 1].pct))).toBe(true);
  expect(m.spark).toEqual(s.map(p => p.pct));
  const downReport = await get<CheckReportDTO>(`/v1/checks/${down.shortId}`);
  expect(downReport.market!.since).toBeCloseTo(downSince, 1);

  // the feed: since % and sparkline per row
  const feed = await get<FeedResponse>('/v1/feed?type=coin');
  const row = feed.items.find(i => i.id === up.shortId)!;
  expect(row.since).toBeCloseTo(upSince, 1);
  expect(row.spark?.length).toBe(TUNING.sparkPoints);

  // "Since check, by verdict": the average move per narrative band over the last 30 days
  const insights = await get<InsightsDTO>('/v1/insights');
  const bands = new Map<string, { n: number; avg: number }>();
  for (const c of [{ band: up.narBand!, pct: upSince }, { band: down.narBand!, pct: downSince }]) {
    const b = bands.get(c.band) ?? { n: 0, avg: 0 };
    bands.set(c.band, { n: b.n + 1, avg: (b.avg * b.n + c.pct) / (b.n + 1) });
  }
  for (const [band, want] of bands) {
    const got = insights.sinceByVerdict.find(x => x.key === band);
    expect(got, `band ${band}`).toBeTruthy();
    expect(got!.n).toBe(want.n);
    expect(got!.avg).toBeCloseTo(want.avg, 0);
    expect(Math.abs(got!.avg - want.avg)).toBeLessThanOrEqual(0.05);
  }

  // on to day 31 (a tick every hour is enough to see the cadence: hourly to day 7, daily to day 30, then none)
  const anchor = up.finishedAt!.getTime();
  for (let t = t0 + span + HOUR; t <= anchor + 31 * 24 * HOUR; t += HOUR) await runPriceTick({ prisma, dex: sources.dex, log: memoryLogger() }, t);
  const all = await prisma.pricePoint.findMany({ where: { targetId: up.targetId }, orderBy: { ts: 'asc' } });
  const day = (p: { ts: Date }) => (p.ts.getTime() - anchor) / (24 * HOUR);
  const between = (a: number, b: number) => all.filter(p => day(p) > a && day(p) <= b);
  const gapsIn = (list: typeof all) => list.slice(1).map((p, i) => (p.ts.getTime() - list[i].ts.getTime()) / HOUR);
  expect(gapsIn(between(2.1, 6.9)).every(g => g === 1)).toBe(true);
  expect(gapsIn(between(8, 30)).every(g => g === 24)).toBe(true);
  expect(between(30, 31)).toEqual([]);
  expect(all.length).toBeGreaterThan(96 + 6 * 24 + 20);
}, 300_000);
