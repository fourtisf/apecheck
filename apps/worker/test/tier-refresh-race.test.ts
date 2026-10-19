/**
 * Tier writes racing each other (HANDOFF §8 tiers; packages/db refreshUserTier, src/maintenance/tiers.ts). The hourly
 * refresh loads who is due and works through them for minutes while the API signs users in and links wallets; a tier
 * computed from an older copy of the user must never overwrite a newer one, since that stored tier is then trusted for
 * an hour (TIER_CACHE_MS) by the API, the bot limits, alerts and automatic re-checks. The interleavings are made
 * deterministic: the API's moves run inside the job's balance read, or right after the job has loaded its batch.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TIER_CACHE_MS, computeTier, refreshUserTier, type PrismaClient, type ReadBalance, type User } from '@apecheck/db';
import { memoryLogger } from '../src/log';
import { refreshTiers } from '../src/maintenance/tiers';
import { prisma, resetDb, testEnv } from './helpers';

const HOUR = 3600_000;
const TOKEN = 'ApeCheckMint11111111111111111111111111111111';
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const EVM = '0x' + 'ab'.repeat(20);
const env = testEnv({ TOKEN_CHAIN: 'sol', TOKEN_ADDRESS: TOKEN, PRO_MIN_HOLD: '250000', MAX_MIN_HOLD: '2500000' });

beforeEach(() => resetDb());
afterAll(() => prisma.$disconnect());

/** a reader answering from a table (unknown wallets hold 0), counting its calls */
function reader(table: Record<string, number>, before?: (owner: string, call: number) => Promise<void>) {
  const calls: string[] = [];
  const read: ReadBalance = async ({ owner }) => {
    calls.push(owner);
    await before?.(owner, calls.length);
    return table[owner] ?? 0;
  };
  return { read, calls };
}

/** what POST /v1/auth/verify does when a signed-in user links a Solana wallet: link, then a forced balance read */
async function apiLinksSolWallet(id: string, holding: number) {
  const linked = await prisma.user.update({ where: { id }, data: { solAddress: SOL, tierCheckedAt: null } });
  return refreshUserTier(prisma, linked, { env, readBalance: reader({ [SOL]: holding }).read, force: true });
}

/** an EVM-only user seen today whose tier was last read two hours ago (the token is on Solana: they hold nothing we see) */
const evmOnlyUser = () =>
  prisma.user.create({ data: { evmAddress: EVM, lastSeenAt: new Date(), tierCheckedAt: new Date(Date.now() - 2 * HOUR), tierReadAt: new Date(Date.now() - 2 * HOUR), holding: 0 } });

/** `db` whose user.findMany (the job loading its batch) runs `after` once it has answered */
function afterBatchLoad(db: PrismaClient, after: () => Promise<unknown>): PrismaClient {
  const user = new Proxy(db.user, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop !== 'findMany' || typeof v !== 'function') return typeof v === 'function' ? v.bind(target) : v;
      return async (...args: unknown[]) => {
        const rows = await v.apply(target, args);
        await after();
        return rows;
      };
    },
  });
  return new Proxy(db, { get: (target, prop) => (prop === 'user' ? user : Reflect.get(target, prop)) });
}

const stored = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

describe('tier writes never overwrite a newer tier', () => {
  it('a wallet linked after the job loaded its batch: the job skips the user, the linked holding stays (and is trusted)', async () => {
    const u = await evmOnlyUser();
    let signIn: Awaited<ReturnType<typeof apiLinksSolWallet>> | null = null;
    const db = afterBatchLoad(prisma, async () => {
      signIn = await apiLinksSolWallet(u.id, 3_000_000);
    });
    const res = await refreshTiers({ env, prisma: db, readBalance: reader({}).read, log: memoryLogger() });
    expect(signIn!.user).toMatchObject({ tier: 'MAX', solAddress: SOL });
    expect(res).toMatchObject({ users: 1, skipped: 1, read: 0, changed: 0 });
    const row = await stored(u.id);
    expect(row).toMatchObject({ tier: 'MAX', solAddress: SOL });
    expect(Number(row.holding)).toBe(3_000_000);
    expect(row.tierCheckedAt).toEqual(signIn!.user.tierCheckedAt);
    // the next /v1/me within the hour: served from the stored row, Max
    expect(await computeTier({ env, user: row, readBalance: reader({}).read })).toMatchObject({ tier: 'max', holding: 3_000_000, holder: true, read: false });
  });

  it('a tier computed from a copy of the user read before a wallet link is not written (job or another request alike)', async () => {
    const u = await evmOnlyUser();
    const before = await stored(u.id);
    const signIn = await apiLinksSolWallet(u.id, 3_000_000);
    // the old copy has no Solana wallet: computed alone it would be Free / 0, read now
    const late = await refreshUserTier(prisma, before, { env, readBalance: reader({}).read, now: new Date() });
    expect(late.result).toMatchObject({ tier: 'max', holding: 3_000_000, read: false });
    expect(late.user).toMatchObject({ tier: 'MAX', solAddress: SOL });
    const row = await stored(u.id);
    expect(row).toMatchObject({ tier: 'MAX' });
    expect(Number(row.holding)).toBe(3_000_000);
    expect(row.tierCheckedAt).toEqual(signIn.user.tierCheckedAt);
  });

  it('a sign-in that stores a newer read while the job is reading the same wallet wins over the job', async () => {
    const u = await prisma.user.create({
      data: { solAddress: SOL, lastSeenAt: new Date(), tier: 'FREE', holding: 0, tierCheckedAt: new Date(Date.now() - 2 * HOUR), tierReadAt: new Date(Date.now() - 2 * HOUR) },
    });
    let signIn: Awaited<ReturnType<typeof refreshUserTier>> | null = null;
    // the job's read answers with the balance from before the buy, after the sign-in has stored the new one
    const job = reader({ [SOL]: 0 }, async () => {
      const current = await stored(u.id);
      signIn = await refreshUserTier(prisma, current, { env, readBalance: reader({ [SOL]: 3_000_000 }).read, force: true });
    });
    const res = await refreshTiers({ env, prisma, readBalance: job.read, log: memoryLogger() });
    // the job read once, but its (older) answer was not stored: the result is the sign-in's, as stored
    expect(job.calls).toEqual([SOL]);
    expect(res).toMatchObject({ users: 1, failed: 0, skipped: 0 });
    const row = await stored(u.id);
    expect(row).toMatchObject({ tier: 'MAX' });
    expect(Number(row.holding)).toBe(3_000_000);
    expect(row.tierCheckedAt).toEqual(signIn!.user.tierCheckedAt);
  });

  it('a forced read whose write lost to a read stored after it started is not repeated: the stored one is returned', async () => {
    const u = await prisma.user.create({ data: { solAddress: SOL, tier: 'PRO', holding: 300_000, tierCheckedAt: new Date(Date.now() - 10 * 60_000) } });
    const first = await stored(u.id);
    // two sign-ins at once (two tabs): the second stores its read while the first is still reading
    const a = reader({ [SOL]: 1_000_000 }, async (_owner, call) => {
      if (call === 1) await refreshUserTier(prisma, await stored(u.id), { env, readBalance: reader({ [SOL]: 3_000_000 }).read, force: true });
    });
    const res = await refreshUserTier(prisma, first, { env, readBalance: a.read, force: true });
    expect(a.calls).toHaveLength(1);
    expect(res.result).toMatchObject({ tier: 'max', holding: 3_000_000, read: false });
    expect(Number((await stored(u.id)).holding)).toBe(3_000_000);
  });

  it('a wallet linked while a forced read was running is read again, from the row as stored', async () => {
    const u = await evmOnlyUser();
    const evmEnv = testEnv({ TOKEN_CHAIN: 'base', TOKEN_ADDRESS: '0x' + '7e'.repeat(20), PRO_MIN_HOLD: '250000', MAX_MIN_HOLD: '2500000' });
    const first = await stored(u.id);
    const r = reader({ [EVM]: 300_000 }, async (_owner, call) => {
      if (call === 1) await prisma.user.update({ where: { id: u.id }, data: { solAddress: SOL, tierCheckedAt: null } });
    });
    const res = await refreshUserTier(prisma, first, { env: evmEnv, readBalance: r.read, force: true });
    expect(r.calls).toEqual([EVM, EVM]);
    expect(res.user).toMatchObject({ tier: 'PRO', solAddress: SOL });
    expect(res.user.tierCheckedAt).not.toBeNull();
    expect(await stored(u.id)).toMatchObject({ tier: 'PRO', solAddress: SOL });
  });

  it('gives up after a few conflicting writes and returns the row as stored, without writing over it', async () => {
    const u = await prisma.user.create({
      data: { solAddress: SOL, tier: 'PRO', holding: 300_000, tierCheckedAt: new Date(Date.now() - 2 * HOUR), tierReadAt: new Date(Date.now() - 2 * HOUR) },
    });
    // someone else stores a (still stale) tier during every read of ours
    const r = reader({ [SOL]: 3_000_000 }, async (_owner, call) => {
      await prisma.user.update({ where: { id: u.id }, data: { tierCheckedAt: new Date(Date.now() - TIER_CACHE_MS - call * 60_000) } });
    });
    const res = await refreshUserTier(prisma, await stored(u.id), { env, readBalance: r.read });
    expect(r.calls).toHaveLength(3);
    const row = await stored(u.id);
    expect(row).toMatchObject({ tier: 'PRO' });
    expect(res.user).toEqual(row);
    expect(res.result).toMatchObject({ tier: 'pro', holding: 300_000, read: false });
  });

  it('without a race the job still writes what it read, with the time it read it', async () => {
    const u = await evmOnlyUser();
    // a fractional stored holding: the write's check against the row as read compares it exactly
    await prisma.user.update({ where: { id: u.id }, data: { solAddress: SOL, holding: '1234.123456789' } });
    const before = Date.now();
    const res = await refreshTiers({ env, prisma, readBalance: reader({ [SOL]: 300_000 }).read, log: memoryLogger() });
    expect(res).toMatchObject({ users: 1, read: 1, changed: 1, skipped: 0 });
    const row: User = await stored(u.id);
    expect(row).toMatchObject({ tier: 'PRO' });
    expect(row.tierCheckedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.tierReadAt).toEqual(row.tierCheckedAt);
  });
});
