/**
 * End to end through the real queue: a CheckJob on "checks" is picked up by the BullMQ worker
 * (startCheckWorker, as worker-checks runs it), with the real createSources() adapters, real Chromium
 * behind the SSRF guard proxy, the test database and Redis. The site is the local working-app fixture;
 * outside data sources have no network here, so they report themselves unavailable.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { QUEUES, type CheckEvidence, type CheckJob } from '@apecheck/core';
import { createSources } from '@apecheck/sources';
import { memoryLogger } from '../../src/log';
import { startCheckWorker, type CheckWorkerHandle } from '../../src/worker';
import { serveFixture, testLookup, type FixtureSite } from '../fixture-server';
import { fakeHttp } from '../fakes';
import { createCheck, prisma, resetDb, testEnv } from '../helpers';

let site: FixtureSite;
let worker: CheckWorkerHandle;
let queue: Queue<CheckJob>;
let conn: Redis;

beforeAll(async () => {
  await resetDb();
  site = await serveFixture('working-app');
  const env = testEnv({ SSRF_ALLOW_HOSTS: site.host });
  const sources = createSources(env, { http: fakeHttp(env.SSRF_ALLOW_HOSTS) });
  worker = await startCheckWorker({ env, sources, log: memoryLogger(), browser: { lookup: testLookup }, recover: false });
  conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  queue = new Queue<CheckJob>(QUEUES.checks, { connection: conn });
  await queue.obliterate({ force: true }).catch(() => undefined);
});

afterAll(async () => {
  await worker?.close(1000);
  await queue?.close();
  await conn?.quit();
  await site?.close();
  await prisma.$disconnect();
});

it('a queued check on the local working-app fixture finishes DONE with the expected verdict', async () => {
  const check = await createCheck(site.url);
  await queue.add('check', { checkId: check.id }, { jobId: check.id });

  const deadline = Date.now() + 180_000;
  let status = 'QUEUED';
  while (Date.now() < deadline) {
    status = (await prisma.check.findUniqueOrThrow({ where: { id: check.id }, select: { status: true } })).status;
    if (status === 'DONE' || status === 'FAILED') break;
    await new Promise(r => setTimeout(r, 500));
  }
  expect(status).toBe('DONE');

  const c = await prisma.check.findUniqueOrThrow({ where: { id: check.id }, include: { steps: { orderBy: { idx: 'asc' } }, claims: true } });
  // the transaction is reached but our RPC can't simulate it here: not shown to work (warn), never "end to end"
  expect([c.sigLaunch, c.sigFlow, c.sigDocs]).toEqual(['OK', 'WARN', 'OK']);
  expect(c.summary).toMatch(/^The app reaches a transaction, but it couldn't be simulated; /);
  expect(c.narScore).toBeGreaterThan(0);
  expect(c.isLatest).toBe(true);
  expect(c.claims.length).toBeGreaterThan(0);
  const texts = c.steps.map(s => s.text);
  // the RPC is unreachable here: the transaction was reached but not simulated (not the project's fault)
  expect(texts.some(t => /^Main flow reached a transaction; it could not be simulated \(/.test(t))).toBe(true);
  expect(texts).toContain('GitHub unavailable, code not checked');
  expect(texts).toContain('X unavailable, account age unknown');
  const ev = c.evidence as CheckEvidence;
  expect(ev.stubbed).toEqual(expect.arrayContaining(['x', 'fourtis', 'ai']));
  expect(c.durationMs!).toBeLessThan(180_000);

  const job = await queue.getJob(check.id);
  expect(await job?.getState()).toBe('completed');
  expect(job?.returnvalue).toEqual({ status: 'done' });
});
