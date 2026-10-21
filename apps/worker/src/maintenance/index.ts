/**
 * worker-prices also runs the slow periodic jobs of M3 on their own queue ("maintenance", produced and consumed only
 * here), so they never hold up a price tick: the hourly tier refresh (tiers.ts) and the logo backfill for coins
 * without a logo (logos.ts, every 10 minutes and once at start). One job at a time.
 *
 * The daily deployer refresh (RETIRED_DEPLOYERS_JOB) is gone: it only ever asked a third-party service ApeCheck no
 * longer uses. Deployer history is now read from ApeCheck's own checks when it is shown, so nothing needs refreshing.
 * Its job scheduler may still sit in Redis from an older release: startMaintenanceWorker removes it, and a leftover
 * job of that name finishes as a no-op.
 */
import { Queue, Worker, type Job } from 'bullmq';
import type { Env } from '@apecheck/core';
import { prisma as defaultPrisma, type PrismaClient, type ReadBalance } from '@apecheck/db';
import { createSources, walletTokenBalance, type Sources } from '@apecheck/sources';
import { createLogger, type Logger } from '../log';
import { bullConnection } from '../redis';
import type { RunningWorker } from '../worker';
import { LOGOS_EVERY_MS, LOGOS_JOB, backfillLogos } from './logos';
import { TIERS_JOB, TIERS_PATTERN, refreshTiers } from './tiers';

export { refreshTiers, TIERS_JOB, TIERS_PATTERN, type TierRefreshResult } from './tiers';
export { backfillLogos, LOGOS_JOB, LOGOS_EVERY_MS, type LogoBackfillResult } from './logos';

export const MAINTENANCE_QUEUE = 'maintenance';
/** the retired daily deployer refresh: its scheduler is removed at start, a leftover job does nothing */
export const RETIRED_DEPLOYERS_JOB = 'deployers-refresh';

/** Balance reads for computeTier: the wallet's TOKEN_ADDRESS balance through @apecheck/sources (null when unreadable). */
export function balanceReader(sources: Pick<Sources, 'evm' | 'sol'>): ReadBalance {
  return async ({ chain, token, owner }) => {
    const evm = sources.evm.tokenBalance ? { tokenBalance: sources.evm.tokenBalance.bind(sources.evm) } : null;
    const sol = sources.sol.tokenBalance ? { tokenBalance: sources.sol.tokenBalance.bind(sources.sol) } : null;
    if (!evm || !sol) return null;
    return walletTokenBalance({ evm, sol }, chain, token, owner);
  };
}

export interface MaintenanceWorkerOptions {
  env: Env;
  prisma?: PrismaClient;
  sources?: Sources;
  log?: Logger;
}

export async function startMaintenanceWorker(opts: MaintenanceWorkerOptions): Promise<RunningWorker & { queue: Queue }> {
  const { env } = opts;
  const log = opts.log ?? createLogger('maintenance');
  const prisma = opts.prisma ?? defaultPrisma;
  const sources = opts.sources ?? createSources(env);
  const readBalance = balanceReader(sources);
  const bull = bullConnection(env.REDIS_URL);
  const queue = new Queue(MAINTENANCE_QUEUE, { connection: bull });
  const keep = { removeOnComplete: 20, removeOnFail: 20 };
  // an older release scheduled the retired deployer refresh daily: without this the scheduler in Redis keeps firing
  await queue.removeJobScheduler(RETIRED_DEPLOYERS_JOB).catch(err => log.warn(`could not remove the ${RETIRED_DEPLOYERS_JOB} scheduler`, err));
  await queue.upsertJobScheduler(TIERS_JOB, { pattern: TIERS_PATTERN, tz: 'UTC' }, { name: TIERS_JOB, data: {}, opts: keep });
  await queue.upsertJobScheduler(LOGOS_JOB, { every: LOGOS_EVERY_MS }, { name: LOGOS_JOB, data: {}, opts: keep });
  // and one right away, so coins checked before an upgrade get their logo without waiting
  await queue.add(LOGOS_JOB, {}, keep);
  const triedLogos = new Map<string, number>();
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job: Job) => {
      if (job.name === TIERS_JOB) return refreshTiers({ env, prisma, readBalance, log });
      if (job.name === LOGOS_JOB) return backfillLogos({ prisma, sources, screenshotDir: env.SCREENSHOT_DIR, log, tried: triedLogos });
      // queued by an older release before its scheduler was removed: nothing to do
      if (job.name === RETIRED_DEPLOYERS_JOB) return { retired: true };
      log.warn(`unknown maintenance job ${job.name}`);
      return null;
    },
    // a tier refresh can take minutes (one balance read per wallet)
    { connection: bull, concurrency: 1, lockDuration: 300_000 },
  );
  worker.on('failed', (job, err) => log.error(`${job?.name ?? 'maintenance job'} failed`, err));
  worker.on('error', err => log.error('maintenance worker error', err));
  log.info(`tier refresh hourly (${TIERS_PATTERN} UTC); coin logo backfill every ${LOGOS_EVERY_MS / 60_000} minutes`);
  let closing: Promise<void> | null = null;
  return {
    queue,
    close: () =>
      (closing ??= (async () => {
        await worker.close().catch(() => undefined);
        await queue.close().catch(() => undefined);
        await bull.quit().catch(() => undefined);
      })()),
  };
}
