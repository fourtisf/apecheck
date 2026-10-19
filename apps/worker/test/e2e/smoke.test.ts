/**
 * One real check end to end against a public site (E2E_TARGET, default https://uniswap.org) with the real
 * data sources, real AI (when ANTHROPIC_API_KEY is set), the real queue and database. Needs open internet,
 * so it only runs with E2E=1 (meant for the VPS: `E2E=1 pnpm e2e`). Keys come from the repo-root .env;
 * the database and Redis stay the isolated test ones.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES, type CheckJob } from '@apecheck/core';
import { loadEnv } from '@apecheck/core/node';
import { createLogger } from '../../src/log';
import { startCheckWorker, type CheckWorkerHandle } from '../../src/worker';
import { createCheck, prisma, tmpDir } from '../helpers';

const enabled = process.env.E2E === '1';
const target = process.env.E2E_TARGET || 'https://uniswap.org';

describe.skipIf(!enabled)(`public smoke check: ${target}`, () => {
  let worker: CheckWorkerHandle;
  let queue: Queue<CheckJob>;
  let conn: Redis;

  beforeAll(async () => {
    // keys from .env, but never its DATABASE_URL / REDIS_URL: the test config already set the isolated ones
    const env = loadEnv({ override: false });
    env.SCREENSHOT_DIR = tmpDir('apecheck-e2e-shots-');
    worker = await startCheckWorker({ env, log: createLogger('e2e'), recover: false });
    conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue<CheckJob>(QUEUES.checks, { connection: conn });
  });

  afterAll(async () => {
    await worker?.close(1000);
    await queue?.close();
    await conn?.quit();
    await prisma.$disconnect();
  });

  it('finishes a real check within the budget', async () => {
    const check = await createCheck(target);
    await queue.add('check', { checkId: check.id }, { jobId: check.id });
    const end = Date.now() + 4 * 60_000;
    let status = 'QUEUED';
    while (Date.now() < end) {
      status = (await prisma.check.findUniqueOrThrow({ where: { id: check.id }, select: { status: true } })).status;
      if (status === 'DONE' || status === 'FAILED') break;
      await new Promise(r => setTimeout(r, 1000));
    }
    const c = await prisma.check.findUniqueOrThrow({ where: { id: check.id }, include: { steps: { orderBy: { idx: 'asc' } } } });
    for (const s of c.steps) console.log(`${String(s.tMs).padStart(6)}ms [${s.status}] ${s.text}`);
    expect(status).toBe('DONE');
    expect(c.sigLaunch).not.toBeNull();
    expect(c.narScore).not.toBeNull();
    expect(c.steps.length).toBeGreaterThan(4);
    expect(c.steps.some(s => s.screenshot)).toBe(true);
  });
});
