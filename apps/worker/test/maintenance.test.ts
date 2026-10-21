/**
 * The M3 periodic jobs of worker-prices' "maintenance" queue:
 *  - the retired daily deployer refresh: its scheduler is removed at start, a leftover job does nothing;
 *  - tier refresh (hourly): users seen in the last 7 days with a tier older than an hour, idle Pro/Max users daily;
 *    the token's balance across linked wallets, TIER_OVERRIDES while the token isn't live, a failed read keeps the tier.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { memoryLogger } from '../src/log';
import { refreshTiers } from '../src/maintenance/tiers';
import { LOGOS_JOB, MAINTENANCE_QUEUE, RETIRED_DEPLOYERS_JOB, TIERS_JOB, balanceReader, startMaintenanceWorker } from '../src/maintenance/index';
import { fakeSources } from './fakes';
import { prisma, resetDb, testEnv } from './helpers';

const DAY = 86_400_000;
const HOUR = 3600_000;

beforeEach(() => resetDb());
afterAll(() => prisma.$disconnect());

describe('retired deployer refresh', () => {
  it('startMaintenanceWorker removes the daily scheduler an older release left in Redis; a leftover job is a no-op', async () => {
    const env = testEnv();
    const conn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(MAINTENANCE_QUEUE, { connection: conn });
    const events = new QueueEvents(MAINTENANCE_QUEUE, { connection: conn.duplicate() });
    await events.waitUntilReady();
    let worker: Awaited<ReturnType<typeof startMaintenanceWorker>> | null = null;
    try {
      // what the old worker-prices registered
      await queue.upsertJobScheduler(RETIRED_DEPLOYERS_JOB, { pattern: '40 4 * * *', tz: 'UTC' }, { name: RETIRED_DEPLOYERS_JOB, data: {} });
      expect(await queue.getJobScheduler(RETIRED_DEPLOYERS_JOB)).toBeTruthy();

      const log = memoryLogger();
      worker = await startMaintenanceWorker({ env, prisma, sources: fakeSources(env), log });
      expect(await queue.getJobScheduler(RETIRED_DEPLOYERS_JOB)).toBeFalsy();
      expect(await queue.getJobScheduler(TIERS_JOB)).toBeTruthy();
      expect(await queue.getJobScheduler(LOGOS_JOB)).toBeTruthy();
      expect(log.lines.join('\n')).toContain('tier refresh hourly');

      // a job of the old name still queued: finishes without doing anything
      const job = await queue.add(RETIRED_DEPLOYERS_JOB, {});
      expect(await job.waitUntilFinished(events, 15_000)).toEqual({ retired: true });
      expect(log.lines.join('\n')).not.toContain('unknown maintenance job');
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await events.close();
      await queue.close();
      await conn.quit();
    }
  });
});

describe('tier refresh', () => {
  const TOKEN = 'ApeCheckMint11111111111111111111111111111111';
  const live = { TOKEN_CHAIN: 'sol', TOKEN_ADDRESS: TOKEN, PRO_MIN_HOLD: '250000', MAX_MIN_HOLD: '2500000' };
  let n = 0;
  const user = (data: { tier?: 'FREE' | 'PRO' | 'MAX'; seenAgo?: number | null; checkedAgo?: number | null; holding?: number | null; sol?: string; evm?: string }) =>
    prisma.user.create({
      data: {
        solAddress: data.sol ?? `So1User${String(++n).padStart(37, '1')}`,
        evmAddress: data.evm ?? null,
        tier: data.tier ?? 'FREE',
        lastSeenAt: data.seenAgo == null ? null : new Date(Date.now() - data.seenAgo),
        tierCheckedAt: data.checkedAgo == null ? null : new Date(Date.now() - data.checkedAgo),
        holding: data.holding ?? null,
      },
    });

  it('re-reads stale tiers of users seen this week and of idle paid users once a day', async () => {
    const buyer = await user({ seenAgo: HOUR, checkedAgo: 2 * HOUR, holding: 0 });
    const seller = await user({ tier: 'MAX', seenAgo: 3 * DAY, checkedAgo: 2 * HOUR, holding: 3_000_000 });
    const fresh = await user({ seenAgo: HOUR, checkedAgo: 10 * 60_000, holding: 0 });
    const gone = await user({ seenAgo: 30 * DAY, checkedAgo: 5 * DAY, holding: 0 });
    const idlePro = await user({ tier: 'PRO', seenAgo: 30 * DAY, checkedAgo: 2 * DAY, holding: 300_000 });
    const idleProRecent = await user({ tier: 'PRO', seenAgo: 30 * DAY, checkedAgo: 3 * HOUR, holding: 300_000 });
    const balances: Record<string, number | null> = {
      [buyer.solAddress!]: 400_000,
      [seller.solAddress!]: 10,
      [fresh.solAddress!]: 9_000_000,
      [gone.solAddress!]: 9_000_000,
      [idlePro.solAddress!]: 0,
      [idleProRecent.solAddress!]: 0,
    };
    const env = testEnv(live);
    const sources = fakeSources(env, { balances });
    const res = await refreshTiers({ env, prisma, readBalance: balanceReader(sources), log: memoryLogger() });
    expect(res).toMatchObject({ users: 3, read: 3, failed: 0, changed: 3 });
    const tier = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).tier;
    expect(await tier(buyer.id)).toBe('PRO');
    expect(await tier(seller.id)).toBe('FREE');
    expect(await tier(idlePro.id)).toBe('FREE');
    // not due: read less than an hour ago / not seen for a week / an idle Pro read today
    expect(await tier(fresh.id)).toBe('FREE');
    expect(await tier(gone.id)).toBe('FREE');
    expect(await tier(idleProRecent.id)).toBe('PRO');
    const b = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(Number(b.holding)).toBe(400_000);
    expect(Date.now() - b.tierCheckedAt!.getTime()).toBeLessThan(60_000);
  });

  it('a failed balance read keeps the tier; while the token is not live only TIER_OVERRIDES give a tier', async () => {
    const pro = await user({ tier: 'PRO', seenAgo: HOUR, checkedAgo: 2 * HOUR, holding: 300_000 });
    const env = testEnv(live);
    const res = await refreshTiers({ env, prisma, readBalance: balanceReader(fakeSources(env, { balances: { [pro.solAddress!]: null } })), log: memoryLogger() });
    expect(res).toMatchObject({ users: 1, read: 0, failed: 1, changed: 0 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: pro.id } })).toMatchObject({ tier: 'PRO' });

    await resetDb();
    const team = await user({ seenAgo: HOUR, evm: '0x' + 'Ab'.repeat(20) });
    const was = await user({ tier: 'MAX', seenAgo: HOUR });
    const notLive = testEnv({ TIER_OVERRIDES: `${'0x' + 'ab'.repeat(20)}:max` });
    const sources = fakeSources(notLive);
    const r2 = await refreshTiers({ env: notLive, prisma, readBalance: balanceReader(sources), log: memoryLogger() });
    expect(r2).toMatchObject({ users: 2, read: 0, changed: 2 });
    expect(sources.calls.filter(c => c.includes('tokenBalance'))).toEqual([]);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject({ tier: 'MAX' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: was.id } })).toMatchObject({ tier: 'FREE' });
  });

  it('failed reads keep a paid tier only a day after the last good read: then Free, logged once', async () => {
    const idleMax = await user({ tier: 'MAX', seenAgo: 30 * DAY, checkedAgo: 25 * HOUR, holding: 3_000_000 });
    const seen = await user({ tier: 'PRO', seenAgo: HOUR, checkedAgo: 2 * HOUR, holding: 300_000 });
    await prisma.user.update({ where: { id: idleMax.id }, data: { tierReadAt: new Date(Date.now() - 25 * HOUR) } });
    await prisma.user.update({ where: { id: seen.id }, data: { tierReadAt: new Date(Date.now() - 23 * HOUR) } });
    const env = testEnv(live);
    const failing = balanceReader(fakeSources(env, { balances: { [idleMax.solAddress!]: null, [seen.solAddress!]: null } }));
    const log = memoryLogger();
    const res = await refreshTiers({ env, prisma, readBalance: failing, log });
    expect(res).toMatchObject({ users: 2, read: 0, failed: 2, changed: 1 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: idleMax.id } })).toMatchObject({ tier: 'FREE', holding: null });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: seen.id } })).toMatchObject({ tier: 'PRO' });
    expect(log.lines.filter(l => l.includes('holding dropped'))).toEqual([expect.stringContaining(`warn user ${idleMax.id}:`)]);

    // an hour later the seen user is past the day too
    const later = Date.now() + 2 * HOUR;
    const log2 = memoryLogger();
    const r2 = await refreshTiers({ env, prisma, readBalance: failing, log: log2 }, later);
    expect(r2).toMatchObject({ failed: 1, changed: 1 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: seen.id } })).toMatchObject({ tier: 'FREE', holding: null });
    expect(log2.lines.filter(l => l.includes('holding dropped'))).toEqual([expect.stringContaining(`warn user ${seen.id}:`)]);
  });
});
