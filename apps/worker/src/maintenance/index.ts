/**
 * worker-prices also runs the slow periodic jobs of M3 on their own queue ("maintenance", produced and consumed only
 * here), so they never hold up a price tick: the daily deployer refresh from DevRadar (deployers.ts) and the hourly
 * tier refresh (tiers.ts). One job at a time.
 */
import { Queue, Worker, type Job } from 'bullmq';
import type { Env } from '@apecheck/core';
import { prisma as defaultPrisma, type PrismaClient, type ReadBalance } from '@apecheck/db';
import { createSources, walletTokenBalance, type Sources } from '@apecheck/sources';
import { createLogger, type Logger } from '../log';
import { bullConnection } from '../redis';
import type { RunningWorker } from '../worker';
import { DEPLOYERS_JOB, DEPLOYERS_PATTERN, refreshDeployers } from './deployers';
import { TIERS_JOB, TIERS_PATTERN, refreshTiers } from './tiers';

export { refreshDeployers, DEPLOYERS_JOB, DEPLOYERS_PATTERN, type DeployerRefreshResult } from './deployers';
export { refreshTiers, TIERS_JOB, TIERS_PATTERN, type TierRefreshResult } from './tiers';

export const MAINTENANCE_QUEUE = 'maintenance';

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
  await queue.upsertJobScheduler(DEPLOYERS_JOB, { pattern: DEPLOYERS_PATTERN, tz: 'UTC' }, { name: DEPLOYERS_JOB, data: {}, opts: keep });
  await queue.upsertJobScheduler(TIERS_JOB, { pattern: TIERS_PATTERN, tz: 'UTC' }, { name: TIERS_JOB, data: {}, opts: keep });
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job: Job) => {
      if (job.name === DEPLOYERS_JOB) return refreshDeployers({ prisma, fourtis: sources.fourtis, log });
      if (job.name === TIERS_JOB) return refreshTiers({ env, prisma, readBalance, log });
      log.warn(`unknown maintenance job ${job.name}`);
      return null;
    },
    // a deployer refresh can take minutes (one DevRadar call per coin)
    { connection: bull, concurrency: 1, lockDuration: 300_000 },
  );
  worker.on('failed', (job, err) => log.error(`${job?.name ?? 'maintenance job'} failed`, err));
  worker.on('error', err => log.error('maintenance worker error', err));
  log.info(`deployer refresh daily (${DEPLOYERS_PATTERN} UTC${sources.fourtis.configured ? '' : ', skipped until Fourtis is configured'}); tier refresh hourly (${TIERS_PATTERN} UTC)`);
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
