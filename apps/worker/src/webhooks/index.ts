/**
 * Webhooks consumer (queue "webhooks", M4), hosted by worker-prices: light, no browser. One job per WebhookDelivery
 * (jobId = delivery id): Stage F / the failure paths queue check.completed (pipeline/save.ts afterFinish), the change
 * detector queues watch.changed (watch/recheck.ts), the API queues the "Send test" ping. deliver.ts signs and POSTs.
 *
 * Retries: WEBHOOK_JOB_OPTIONS (6 attempts) with the "webhook" backoff (1 min, ×4 each, ~5.7 h from the first attempt
 * to the last). A repeatable "sweep" job (every 5 minutes) queues again any delivery still pending after 5 minutes whose
 * job is gone (a crash between writing the row and queuing it, a failed enqueue); one pending for more than a day, or
 * with every attempt used, is marked failed instead. Any job on this queue that isn't the sweep is a WebhookJob.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { QUEUES, type Env, type WebhookJob } from '@apecheck/core';
import { prisma as defaultPrisma, type PrismaClient } from '@apecheck/db';
import { createSources, type Http, type Sources } from '@apecheck/sources';
import { createLogger, type Logger } from '../log';
import { bullConnection } from '../redis';
import type { RunningWorker } from '../worker';
import { processDelivery, type DeliverDeps, type DeliveryOutcome } from './deliver';
import { WEBHOOK_BACKOFF, WEBHOOK_DELIVER_JOB, WEBHOOK_JOB_OPTIONS, WEBHOOK_MAX_ATTEMPTS, webhookRetryDelayMs } from './events';

export * from './events';
export { buildPayload, processDelivery, hostOf, WEBHOOK_USER_AGENT, WEBHOOK_TIMEOUT_MS, WEBHOOK_MAX_RESPONSE_BYTES, type DeliverDeps, type DeliveryOutcome } from './deliver';

export const WEBHOOK_SWEEP_JOB = 'sweep';
export const SWEEP_EVERY_MS = 5 * 60_000;
/** a pending delivery this old without a job was lost: queue it again */
export const SWEEP_MIN_AGE_MS = 5 * 60_000;
/** a pending delivery older than this (the retries span ~6 h) is given up instead */
export const SWEEP_GIVE_UP_MS = 24 * 3600_000;
const SWEEP_MAX = 500;
/** BullMQ states in which the job will still run (or is running) */
const ALIVE = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

/** A failed attempt that BullMQ should retry (its message is what the delivery row says). */
export class WebhookRetry extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRetry';
  }
}

export interface WebhooksWorkerOptions {
  env: Env;
  prisma?: PrismaClient;
  sources?: Sources;
  /** default sources.http (createSources(env).http) */
  http?: Http;
  log?: Logger;
  /** deliveries sent in parallel (default 8) */
  concurrency?: number;
  /** wait before a retry after `attemptsMade` failed attempts (default webhookRetryDelayMs; tests shorten it) */
  retryDelayMs?: (attemptsMade: number) => number;
  /** default SWEEP_EVERY_MS; 0 = no repeatable sweep (tests call sweep()) */
  sweepEveryMs?: number;
  now?: () => number;
}

export interface WebhooksWorkerHandle extends RunningWorker {
  queue: Queue<WebhookJob>;
  worker: Worker;
  deps: DeliverDeps;
  /** one sweep now: how many deliveries were queued again */
  sweep(): Promise<number>;
}

/**
 * Pending deliveries whose job is gone: queued again (or failed, when too old or out of attempts). Returns how many
 * were queued again.
 */
export async function sweepLostDeliveries(deps: Pick<DeliverDeps, 'prisma' | 'log' | 'now'>, queue: Queue<WebhookJob>): Promise<number> {
  const now = deps.now ? deps.now() : Date.now();
  const rows = await deps.prisma.webhookDelivery.findMany({
    where: { status: 'pending', createdAt: { lt: new Date(now - SWEEP_MIN_AGE_MS) } },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_MAX,
    select: { id: true, attempts: true, createdAt: true },
  });
  let requeued = 0;
  for (const r of rows) {
    const job = await queue.getJob(r.id);
    const state = job ? await job.getState() : null;
    if (state && ALIVE.has(state)) continue;
    if (r.attempts >= WEBHOOK_MAX_ATTEMPTS || now - r.createdAt.getTime() > SWEEP_GIVE_UP_MS) {
      await deps.prisma.webhookDelivery.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'failed', error: 'Not delivered in time' } });
      continue;
    }
    if (job) await job.remove().catch(() => undefined);
    await queue.add(WEBHOOK_DELIVER_JOB, { deliveryId: r.id }, { jobId: r.id, ...WEBHOOK_JOB_OPTIONS });
    requeued++;
  }
  if (requeued) deps.log.warn(`webhooks: ${requeued} lost deliver${requeued === 1 ? 'y' : 'ies'} queued again`);
  return requeued;
}

export async function startWebhooksWorker(opts: WebhooksWorkerOptions): Promise<WebhooksWorkerHandle> {
  const { env } = opts;
  const log = opts.log ?? createLogger('webhooks');
  const bull = bullConnection(env.REDIS_URL);
  const queue = new Queue<WebhookJob>(QUEUES.webhooks, { connection: bull });
  const deps: DeliverDeps = {
    env,
    prisma: opts.prisma ?? defaultPrisma,
    http: opts.http ?? (opts.sources ?? createSources(env)).http,
    log,
    now: opts.now,
  };
  const sweep = () => sweepLostDeliveries(deps, queue);
  const every = opts.sweepEveryMs ?? SWEEP_EVERY_MS;
  if (every > 0) {
    await queue.upsertJobScheduler('webhooks-sweep', { every }, { name: WEBHOOK_SWEEP_JOB, data: {} as WebhookJob, opts: { removeOnComplete: 20, removeOnFail: 20 } });
  }
  const retryDelay = opts.retryDelayMs ?? ((made: number) => webhookRetryDelayMs(made));
  const worker = new Worker<WebhookJob, DeliveryOutcome | { requeued: number }>(
    QUEUES.webhooks,
    async (job: Job<WebhookJob>) => {
      if (job.name === WEBHOOK_SWEEP_JOB) return { requeued: await sweep() };
      const id = job.data?.deliveryId;
      if (typeof id !== 'string' || !id) return { status: 'skipped', reason: 'no delivery id' };
      const out = await processDelivery(deps, id, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 });
      if (out.status === 'retry') throw new WebhookRetry(out.error);
      return out;
    },
    {
      connection: bull,
      concurrency: Math.max(1, opts.concurrency ?? 8),
      lockDuration: 60_000,
      settings: { backoffStrategy: (made: number, type?: string) => (type === WEBHOOK_BACKOFF ? retryDelay(made) : 60_000) },
    },
  );
  worker.on('failed', (job, err) => {
    if (err instanceof WebhookRetry || err.name === 'WebhookRetry') return; // a retry, already logged
    log.error(`webhook job ${job?.name ?? '?'} ${job?.id ?? ''} failed`, err);
  });
  worker.on('error', err => log.error('webhooks worker error', err));
  log.info(`webhooks: delivering (concurrency ${Math.max(1, opts.concurrency ?? 8)}, ${WEBHOOK_MAX_ATTEMPTS} attempts each)${every > 0 ? `; lost-delivery sweep every ${every / 60_000} minutes` : ''}`);
  let closing: Promise<void> | null = null;
  return {
    queue,
    worker,
    deps,
    sweep,
    close: () =>
      (closing ??= (async () => {
        await worker.close().catch(() => undefined);
        await queue.close().catch(() => undefined);
        await bull.quit().catch(() => undefined);
      })()),
  };
}
