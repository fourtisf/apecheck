/**
 * M3 acceptance for Max watchlists, end to end through the real queues and pipeline: a project's site (the local
 * working-app fixture, served so its text can change) gets a verdict on the real "checks" queue (worker-checks,
 * headless Chromium behind the SSRF guard); a Max and a Pro user watch it; the re-check scan of worker-prices
 * (startWatchWorker, real "rechecks" queue) takes the first fingerprint; the site's text changes; the next scan
 * confirms the change, alerts both watchers and starts one automatic re-check for the Max user (via WEB, requester =
 * the user, PRIORITY.recheck); worker-checks runs it, and Stage F gives the Max user the "rechecked" notification
 * with the new verdict next to the old one.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CHECK_JOB_OPTIONS, PRIORITY, QUEUES, type CheckJob } from '@apecheck/core';
import { createSources } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { startCheckWorker, type CheckWorkerHandle } from '../src/worker';
import { startWatchWorker, type WatchWorkerHandle } from '../src/watch/index';
import { serveHandler, testLookup, type FixtureSite } from './fixture-server';
import { fakeHttp } from './fakes';
import { createCheck, prisma, resetDb, testEnv } from './helpers';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sites', 'working-app');
const ORIGINAL = 'Live on Base mainnet.';
let tagline = ORIGINAL;

let site: FixtureSite;
let checks: CheckWorkerHandle;
let watch: WatchWorkerHandle;
let conn: Redis;
let queue: Queue<CheckJob>;

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 150_000): Promise<T> {
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
  for (const name of [QUEUES.checks, QUEUES.rechecks]) {
    const q = new Queue(name, { connection: conn });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
  // the working-app fixture, with a tagline the test can change
  site = await serveHandler('working-app', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, path.normalize(p));
    try {
      if (!file.startsWith(ROOT)) throw new Error('outside');
      let body = await fs.readFile(file, 'utf8');
      if (p === '/index.html') body = body.replace(ORIGINAL, tagline);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>404 Not Found</title><h1>404 Not Found</h1>');
    }
  });
  const env = testEnv({ SSRF_ALLOW_HOSTS: site.host, WATCH_RECHECK_HOURS: '6', MAX_AUTO_RECHECKS_PER_DAY: '20' });
  const sources = createSources(env, { http: fakeHttp(env.SSRF_ALLOW_HOSTS) });
  checks = await startCheckWorker({ env, sources, log: memoryLogger(), browser: { lookup: testLookup }, recover: false, fetchCard: async () => null });
  watch = await startWatchWorker({ env, sources, log: memoryLogger(), scanEveryMs: 3600_000 });
  queue = new Queue<CheckJob>(QUEUES.checks, { connection: conn });
});

afterAll(async () => {
  await watch?.close();
  await checks?.close(1000);
  await queue?.close();
  await site?.close();
  await conn?.quit();
  await prisma.$disconnect();
});

it('a Max watchlist re-checks a changed site on its own and tells the watcher the new verdict', async () => {
  // the project's first verdict, as the site would start it
  const first = await createCheck(site.url);
  await queue.add('check', { checkId: first.id }, { jobId: first.id, priority: PRIORITY.free, ...CHECK_JOB_OPTIONS });
  const verdict = await until('the first verdict', async () => {
    const c = await prisma.check.findUniqueOrThrow({ where: { id: first.id } });
    return c.status === 'DONE' ? c : null;
  });
  expect(verdict.narScore).not.toBeNull();

  const max = await prisma.user.create({ data: { evmAddress: '0x' + 'ab'.repeat(20), tier: 'MAX' } });
  const pro = await prisma.user.create({ data: { evmAddress: '0x' + 'cd'.repeat(20), tier: 'PRO' } });
  for (const u of [max, pro]) await prisma.watch.create({ data: { userId: u.id, targetId: verdict.targetId } });

  // first scan: the fingerprint is taken, nobody is alerted
  expect(await watch.scan()).toEqual([verdict.targetId]);
  const fp = await until('the first fingerprint', async () => (await prisma.target.findUniqueOrThrow({ where: { id: verdict.targetId } })).fingerprint);
  expect(await prisma.notification.count()).toBe(0);

  // the site's text changes; WATCH_RECHECK_HOURS later the next scan finds it
  tagline = 'Mainnet is paused. Join the waitlist for the relaunch.';
  await prisma.target.update({ where: { id: verdict.targetId }, data: { fingerprintAt: new Date(Date.now() - 7 * 3600_000) } });
  expect(await watch.scan()).toEqual([verdict.targetId]);
  const changed = await until('the change alerts', async () => {
    const n = await prisma.notification.findMany({ where: { kind: 'changed' } });
    return n.length === 2 ? n : null;
  }, 30_000);
  expect((await prisma.target.findUniqueOrThrow({ where: { id: verdict.targetId } })).fingerprint).not.toBe(fp);

  const forMax = changed.find(n => n.userId === max.id)!;
  const forPro = changed.find(n => n.userId === pro.id)!;
  expect(forPro).toMatchObject({ checkId: null, text: 'working-app.test changed since its last check' });
  expect(forMax).toMatchObject({ text: 'working-app.test changed since its last check; re-checking it now' });
  const recheck = await prisma.check.findUniqueOrThrow({ where: { id: forMax.checkId! } });
  expect(recheck).toMatchObject({ via: 'WEB', requesterId: max.id, targetId: verdict.targetId, isPrivate: false, targetRaw: site.url });
  const job = await queue.getJob(recheck.id);
  expect(job?.opts.priority).toBe(PRIORITY.recheck);

  // worker-checks runs the re-check; Stage F completes the Max user's alert with the new verdict
  const rechecked = await until('the rechecked notification', async () => prisma.notification.findFirst({ where: { kind: 'rechecked' } }));
  const done = await prisma.check.findUniqueOrThrow({ where: { id: recheck.id } });
  expect(done.status).toBe('DONE');
  const band = '(Real|Likely real|Partly real|Likely LARP|LARP)';
  expect(rechecked).toMatchObject({ userId: max.id, checkId: recheck.id, targetId: verdict.targetId });
  expect(rechecked.text).toMatch(new RegExp(`^Re-checked working-app\\.test: ${band} ${done.narScore}, was ${band} ${verdict.narScore}$`));
  // only the Max user got one; the Pro user's alert stays as it was
  expect(await prisma.notification.count({ where: { kind: 'rechecked' } })).toBe(1);
  expect((await prisma.watch.findUniqueOrThrow({ where: { userId_targetId: { userId: max.id, targetId: verdict.targetId } } })).lastRecheckAt).not.toBeNull();
  // the re-check is the target's verdict now
  expect((await prisma.check.findUniqueOrThrow({ where: { id: verdict.id } })).isLatest).toBe(false);
  expect(done.isLatest).toBe(true);
}, 300_000);
