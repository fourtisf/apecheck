/**
 * Process wiring shared by the entry points (checks.ts, prices.ts, dev.ts) and the queue e2e test:
 * the BullMQ workers, one lazily launched Chromium per process, graceful shutdown.
 */
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { BOT_REPLY_JOB_OPTIONS, QUEUES, type BotReplyJob, type CheckJob, type Env } from '@apecheck/core';
import { prisma as defaultPrisma, type PrismaClient } from '@apecheck/db';
import { createSources, type Sources } from '@apecheck/sources';
import { createAi } from './ai';
import type { AiAdapter } from './ai/types';
import { BrowserHost, type BrowserHostOptions } from './browser/browser';
import { createLogger, type Logger } from './log';
import { SHOTS_CLEANUP_JOB, SHOTS_CLEANUP_PATTERN, cleanupShots } from './maintenance/shots';
import { RunSuperseded, endStuckCheck, recoverStaleChecks, runCheck, type JobStateLookup, type PipelineDeps, type RunResult } from './pipeline';
import type { StageLimits } from './pipeline/context';
import { fireWebhooksNoop } from './pipeline/save';
import { PRICE_TICK_MS } from './prices/schedule';
import { runPriceTick } from './prices/tick';
import { bullConnection, publisherConnection } from './redis';

/** One Chromium per process, launched on first use and relaunched if it dies. */
export class BrowserPool {
  private host: Promise<BrowserHost | null> | null = null;
  constructor(
    private readonly opts: BrowserHostOptions,
    private readonly log: Logger,
  ) {}

  /**
   * The live browser, relaunched once when it died: of the callers that find the same dead host, exactly one
   * closes it and launches the next (the promise is swapped in before any await); the others wait for that one.
   */
  async get(): Promise<BrowserHost | null> {
    for (;;) {
      const seen = this.host;
      const current = seen ? await seen : null;
      if (current && current.connected) return current;
      // another caller replaced the host while we waited: use theirs
      if (this.host !== seen) continue;
      const launching: Promise<BrowserHost | null> = (async () => {
        if (current) await current.close();
        return BrowserHost.launch(this.opts);
      })().catch(e => {
        this.log.error('Chromium could not start', e);
        if (this.host === launching) this.host = null;
        return null;
      });
      this.host = launching;
      return launching;
    }
  }

  async close(): Promise<void> {
    const h = this.host ? await this.host : null;
    this.host = null;
    await h?.close();
  }
}

export interface CheckWorkerOptions {
  env: Env;
  prisma?: PrismaClient;
  sources?: Sources;
  ai?: AiAdapter;
  log?: Logger;
  /** browser overrides (tests: lookup / checkUrl / proxy mode) */
  browser?: Partial<BrowserHostOptions>;
  fetchCard?: PipelineDeps['fetchCard'];
  limits?: Partial<StageLimits>;
  /** run the recovery of stuck checks at startup and every `recoverEveryMs` (default true) */
  recover?: boolean;
  /** default 5 minutes */
  recoverEveryMs?: number;
}

/** BullMQ state of the check's job (jobId = check id), null when the job is gone. */
export function jobStateOf(queue: Queue<CheckJob>): JobStateLookup {
  return async checkId => {
    const job = await queue.getJob(checkId);
    return job ? await job.getState() : null;
  };
}

export interface RunningWorker {
  close(graceMs?: number): Promise<void>;
}

export interface CheckWorkerHandle extends RunningWorker {
  worker: Worker<CheckJob, Pick<RunResult, 'status' | 'error'>>;
  deps: PipelineDeps;
}

export async function startCheckWorker(opts: CheckWorkerOptions): Promise<CheckWorkerHandle> {
  const { env } = opts;
  const log = opts.log ?? createLogger('checks');
  const prisma = opts.prisma ?? defaultPrisma;
  const bull: Redis = bullConnection(env.REDIS_URL);
  const pub: Redis = publisherConnection(env.REDIS_URL);
  const botQueue = new Queue<BotReplyJob>(QUEUES.botReplies, { connection: bull });
  const pool = new BrowserPool({ env, ...opts.browser }, log);
  const deps: PipelineDeps = {
    env,
    prisma,
    redis: pub,
    sources: opts.sources ?? createSources(env),
    ai: opts.ai ?? createAi(env),
    browser: () => pool.get(),
    log,
    fetchCard: opts.fetchCard,
    limits: opts.limits,
    hooks: {
      enqueueBotReply: async mentionId => {
        await botQueue.add('reply', { mentionId }, { jobId: mentionId, ...BOT_REPLY_JOB_OPTIONS });
      },
      fireWebhooks: fireWebhooksNoop,
    },
  };

  const checksQueue = new Queue<CheckJob>(QUEUES.checks, { connection: bull });
  const jobState = jobStateOf(checksQueue);
  const recover = () => recoverStaleChecks(deps, Date.now(), jobState).catch(e => log.error('stale check recovery failed', e));
  let recoverTimer: NodeJS.Timeout | null = null;
  if (opts.recover !== false) {
    await recover();
    // also later: a job that stalled past its limit or failed outright leaves its check QUEUED / RUNNING
    recoverTimer = setInterval(() => void recover(), opts.recoverEveryMs ?? 5 * 60_000);
    recoverTimer.unref();
  }

  // job id → its run (job ids are check ids)
  const running = new Map<string, AbortController>();
  const worker = new Worker<CheckJob, Pick<RunResult, 'status' | 'error'>>(
    QUEUES.checks,
    async (job: Job<CheckJob>) => {
      const checkId = job.data?.checkId;
      if (typeof checkId !== 'string' || !checkId) return { status: 'skipped' };
      const ctrl = new AbortController();
      const key = job.id ?? checkId;
      running.set(key, ctrl);
      try {
        const r = await runCheck(checkId, deps, { signal: ctrl.signal });
        return { status: r.status, error: r.error };
      } finally {
        if (running.get(key) === ctrl) running.delete(key);
      }
    },
    {
      connection: bull,
      concurrency: Math.max(1, env.MAX_CONCURRENT_BROWSERS),
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    },
  );
  worker.on('failed', (job, err) => {
    log.error(`job ${job?.id ?? '?'} failed`, err);
    // the last attempt failed (e.g. the database was unreachable when the check started): end the check
    // instead of leaving it QUEUED, where it would block new checks of its target
    const checkId = job?.data?.checkId;
    if (!job || typeof checkId !== 'string' || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    void deps.prisma.check
      .findUnique({ where: { id: checkId }, select: { id: true, shortId: true, status: true, startedAt: true, createdAt: true } })
      .then(c => (c && (c.status === 'QUEUED' || c.status === 'RUNNING') ? endStuckCheck(deps, c, c.status === 'RUNNING' ? 'restart' : 'not-run') : false))
      .catch(e => log.error(`could not end the check of failed job ${job.id}`, e));
  });
  // our lock on a job was lost (Redis outage, blocked event loop): BullMQ will hand the job to another run, so
  // this one stops at once without marking, publishing or replying anything
  worker.on('lockRenewalFailed', ids => {
    for (const id of ids) running.get(id)?.abort(new RunSuperseded());
  });
  worker.on('error', err => log.error('worker error', err));
  log.info(`listening on "${QUEUES.checks}" (concurrency ${Math.max(1, env.MAX_CONCURRENT_BROWSERS)}, AI: ${deps.ai.mode})`);

  let closing: Promise<void> | null = null;
  const close = (graceMs = 15_000) =>
    (closing ??= (async () => {
      // stop taking jobs; give running checks a moment, then interrupt them (they mark themselves FAILED)
      const closed = worker.close();
      const finished = await Promise.race([closed.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), graceMs))]);
      if (!finished) {
        for (const c of running.values()) c.abort();
        await Promise.race([closed, new Promise(r => setTimeout(r, 10_000))]);
      }
      if (recoverTimer) clearInterval(recoverTimer);
      await botQueue.close().catch(() => undefined);
      await checksQueue.close().catch(() => undefined);
      await pool.close();
      await pub.quit().catch(() => undefined);
      await bull.quit().catch(() => undefined);
    })());

  return { worker, deps, close };
}

export interface PricesWorkerOptions {
  env: Env;
  prisma?: PrismaClient;
  sources?: Sources;
  log?: Logger;
}

export async function startPricesWorker(opts: PricesWorkerOptions): Promise<RunningWorker> {
  const { env } = opts;
  const log = opts.log ?? createLogger('prices');
  const prisma = opts.prisma ?? defaultPrisma;
  const sources = opts.sources ?? createSources(env);
  const bull = bullConnection(env.REDIS_URL);
  const queue = new Queue(QUEUES.prices, { connection: bull });
  await queue.upsertJobScheduler('prices-tick', { every: PRICE_TICK_MS }, { name: 'tick', data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } });
  // HANDOFF §12.6: daily screenshot cleanup rides the same queue (one job at a time, never alongside a tick)
  await queue.upsertJobScheduler(
    SHOTS_CLEANUP_JOB,
    { pattern: SHOTS_CLEANUP_PATTERN, tz: 'UTC' },
    { name: SHOTS_CLEANUP_JOB, data: {}, opts: { removeOnComplete: 20, removeOnFail: 20 } },
  );
  const worker = new Worker(
    QUEUES.prices,
    async (job: Job) =>
      job.name === SHOTS_CLEANUP_JOB
        ? cleanupShots({ prisma, screenshotDir: env.SCREENSHOT_DIR, log })
        : runPriceTick({ prisma, dex: sources.dex, log }),
    { connection: bull, concurrency: 1 },
  );
  worker.on('failed', (job, err) => log.error(job?.name === SHOTS_CLEANUP_JOB ? 'screenshot cleanup failed' : 'price tick failed', err));
  worker.on('error', err => log.error('worker error', err));
  log.info(`price tracker scheduled every ${PRICE_TICK_MS / 60_000} minutes; screenshot cleanup daily (${SHOTS_CLEANUP_PATTERN} UTC)`);
  let closing: Promise<void> | null = null;
  return {
    close: () =>
      (closing ??= (async () => {
        await worker.close();
        await queue.close();
        await bull.quit().catch(() => undefined);
      })()),
  };
}

/** SIGTERM / SIGINT → close everything, exit. */
export function onShutdown(close: () => Promise<void>, log: Logger) {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: shutting down`);
    // PM2 kill_timeout is 30 s for worker-checks
    const force = setTimeout(() => process.exit(1), 28_000);
    force.unref();
    try {
      await close();
      process.exit(0);
    } catch (e) {
      log.error('shutdown failed', e);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}
