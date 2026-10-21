/**
 * worker-prices hosts the re-check alerts (queue "rechecks"): a repeatable "scan" job every SCAN_EVERY_MS that queues
 * one RecheckJob ({ targetId }, jobId "fp-<targetId>", so a target is never queued twice) per watched target due for
 * a fingerprint, and the consumer of those jobs (recheck.ts). No browser: guarded HTTP and chain RPCs only (no X reads).
 * Any job on this queue that is not "scan" is a RecheckJob (the API may queue one when someone starts watching).
 */
import { Queue, Worker, type Job } from 'bullmq';
import { QUEUES, type CheckJob, type Env, type RecheckJob, type WebhookJob } from '@apecheck/core';
import { prisma as defaultPrisma, type PrismaClient } from '@apecheck/db';
import { createSources, type Sources } from '@apecheck/sources';
import { createLogger, errText, type Logger } from '../log';
import { bullConnection, publisherConnection } from '../redis';
import type { RunningWorker } from '../worker';
import { enqueueDeliveries } from '../webhooks/events';
import { RECHECK_CHECK_JOB, RETRY_AFTER_S, SCAN_EVERY_MS, processRecheck, retryKey, scanWatched, type RecheckDeps, type RecheckOutcome } from './recheck';

export { processRecheck, scanWatched, startAutoRecheck, autoRechecksToday, reserveAutoRecheck, coveredByBaseline, SCAN_EVERY_MS, AUTO_RECHECK_GAP_MS, retryKey, type RecheckDeps, type RecheckOutcome } from './recheck';
export { completeAutoRechecks, changedText, recheckedText, NOTIFY_CHANGED, NOTIFY_RECHECKED } from './notify';
export { fingerprintTarget, siteFingerprint, siteUrl, fingerprintKind, type Fingerprint } from './fingerprint';

export const RECHECK_SCAN_JOB = 'scan';
export const recheckJobId = (targetId: string) => `fp-${targetId}`;

export interface WatchWorkerOptions {
  env: Env;
  prisma?: PrismaClient;
  sources?: Sources;
  log?: Logger;
  /** fingerprints read in parallel (default 4) */
  concurrency?: number;
  /** default SCAN_EVERY_MS */
  scanEveryMs?: number;
  now?: () => number;
  /** wait before the read that confirms a change (default CONFIRM_DELAY_MS) */
  confirmDelayMs?: number;
}

export interface WatchWorkerHandle extends RunningWorker {
  deps: RecheckDeps;
  queue: Queue;
  /** one scan now: the targets it queued */
  scan(): Promise<string[]>;
}

export async function startWatchWorker(opts: WatchWorkerOptions): Promise<WatchWorkerHandle> {
  const { env } = opts;
  const log = opts.log ?? createLogger('watch');
  const bull = bullConnection(env.REDIS_URL);
  const pub = publisherConnection(env.REDIS_URL);
  const queue = new Queue(QUEUES.rechecks, { connection: bull });
  const checks = new Queue<CheckJob>(QUEUES.checks, { connection: bull });
  const webhooks = new Queue<WebhookJob>(QUEUES.webhooks, { connection: bull });
  const deps: RecheckDeps = {
    env,
    prisma: opts.prisma ?? defaultPrisma,
    redis: pub,
    sources: opts.sources ?? createSources(env),
    log,
    now: opts.now,
    confirmDelayMs: opts.confirmDelayMs,
    enqueueCheck: async checkId => {
      await checks.add('check', { checkId }, { jobId: checkId, ...RECHECK_CHECK_JOB });
    },
    enqueueWebhooks: ids => enqueueDeliveries(webhooks, ids),
  };
  const scan = async (): Promise<string[]> => {
    const ids = await scanWatched(deps);
    if (ids.length) {
      await queue.addBulk(
        ids.map(targetId => ({
          name: 'target',
          data: { targetId } satisfies RecheckJob,
          opts: { jobId: recheckJobId(targetId), removeOnComplete: true, removeOnFail: 200 },
        })),
      );
      log.info(`re-check scan: ${ids.length} watched target(s) to fingerprint`);
    }
    return ids;
  };
  const every = opts.scanEveryMs ?? SCAN_EVERY_MS;
  await queue.upsertJobScheduler('rechecks-scan', { every }, { name: RECHECK_SCAN_JOB, data: {}, opts: { removeOnComplete: 20, removeOnFail: 20 } });
  const worker = new Worker<RecheckJob | Record<string, never>, RecheckOutcome | { queued: number }>(
    QUEUES.rechecks,
    async (job: Job) => {
      if (job.name === RECHECK_SCAN_JOB) return { queued: (await scan()).length };
      const targetId = (job.data as RecheckJob)?.targetId;
      try {
        return await processRecheck(deps, targetId);
      } catch (e) {
        // e.g. the database blinked: back off like a failed read and let the job complete, so its fixed jobId
        // (fp-<targetId>) is free for a later scan instead of sitting in the failed set
        log.error(`re-check of target ${targetId} failed`, e);
        if (typeof targetId === 'string' && targetId) await deps.redis.set(retryKey(targetId), '1', 'EX', RETRY_AFTER_S).catch(() => undefined);
        return { status: 'error', reason: errText(e) } satisfies RecheckOutcome;
      }
    },
    { connection: bull, concurrency: Math.max(1, opts.concurrency ?? 4), lockDuration: 120_000 },
  );
  worker.on('failed', (job, err) => log.error(`re-check job ${job?.name ?? '?'} ${job?.id ?? ''} failed`, err));
  worker.on('error', err => log.error('re-check worker error', err));
  log.info(`re-check alerts: scanning watched targets every ${every / 60_000} minutes (fingerprints every ${Math.max(1, env.WATCH_RECHECK_HOURS)} h)`);
  let closing: Promise<void> | null = null;
  return {
    deps,
    queue,
    scan,
    close: () =>
      (closing ??= (async () => {
        await worker.close().catch(() => undefined);
        await queue.close().catch(() => undefined);
        await checks.close().catch(() => undefined);
        await webhooks.close().catch(() => undefined);
        await pub.quit().catch(() => undefined);
        await bull.quit().catch(() => undefined);
      })()),
  };
}
