/**
 * Process wiring shared by the entry points (checks.ts, prices.ts, dev.ts) and the queue e2e test:
 * the BullMQ workers, one lazily launched Chromium per process, graceful shutdown.
 */
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUES, type BotReplyJob, type CheckJob, type Env } from '@apecheck/core';
import { prisma as defaultPrisma, type PrismaClient } from '@apecheck/db';
import { createSources, type Sources } from '@apecheck/sources';
import { createAi } from './ai';
import type { AiAdapter } from './ai/types';
import { BrowserHost, type BrowserHostOptions } from './browser/browser';
import { createLogger, type Logger } from './log';
import { recoverStaleChecks, runCheck, type PipelineDeps, type RunResult } from './pipeline';
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

  async get(): Promise<BrowserHost | null> {
    const current = this.host ? await this.host : null;
    if (current && current.connected) return current;
    if (current) await current.close();
    this.host = BrowserHost.launch(this.opts).catch(e => {
      this.log.error('Chromium could not start', e);
      this.host = null;
      return null;
    });
    return this.host;
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
  /** run the startup recovery of stuck checks (default true) */
  recover?: boolean;
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
        await botQueue.add('reply', { mentionId }, { jobId: mentionId, removeOnComplete: 1000, removeOnFail: 1000 });
      },
      fireWebhooks: fireWebhooksNoop,
    },
  };

  if (opts.recover !== false) await recoverStaleChecks(deps).catch(e => log.error('stale check recovery failed', e));

  const running = new Map<string, AbortController>();
  const worker = new Worker<CheckJob, Pick<RunResult, 'status' | 'error'>>(
    QUEUES.checks,
    async (job: Job<CheckJob>) => {
      const checkId = job.data?.checkId;
      if (typeof checkId !== 'string' || !checkId) return { status: 'skipped' };
      const ctrl = new AbortController();
      running.set(checkId, ctrl);
      try {
        const r = await runCheck(checkId, deps, { signal: ctrl.signal });
        return { status: r.status, error: r.error };
      } finally {
        running.delete(checkId);
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
  worker.on('failed', (job, err) => log.error(`job ${job?.id ?? '?'} failed`, err));
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
      await botQueue.close().catch(() => undefined);
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
  const worker = new Worker(QUEUES.prices, async () => runPriceTick({ prisma, dex: sources.dex, log }), { connection: bull, concurrency: 1 });
  worker.on('failed', (_job, err) => log.error('price tick failed', err));
  worker.on('error', err => log.error('worker error', err));
  log.info(`price tracker scheduled every ${PRICE_TICK_MS / 60_000} minutes`);
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
