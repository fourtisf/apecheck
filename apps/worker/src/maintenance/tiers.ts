/**
 * Tier refresh (HANDOFF §8: "balance read on sign-in, cached 1 h"): an hourly job that recomputes the tier of users
 * whose stored tier is older than TIER_CACHE_MS, so what runs without a visit to the site — the bot's per-user limits
 * and follow-up answers (User.xUserId), re-check alerts and automatic re-checks (watch/*) — uses a current tier.
 *
 * Who: users seen in the last SEEN_DAYS days (User.lastSeenAt: the site, or the bot for an X-linked user), plus Pro
 * and Max users not seen lately at most once a day (their watchlists keep working without visits, and someone who
 * sold must not keep a paid tier forever). The rules are packages/db computeTier() / refreshUserTier(): holding of
 * TOKEN_ADDRESS on TOKEN_CHAIN across the linked wallets, TIER_OVERRIDES, a failed read keeps the last value (and is
 * retried soon) for at most TIER_STALE_MAX_MS after the last good read. While TOKEN_ADDRESS is empty nothing is read:
 * everyone is Free except the override wallets.
 *
 * The job can take minutes, while the API keeps signing users in and linking wallets: it loads only who is due, then
 * reads each user again just before refreshing them (skipping anyone whose tier was stored meanwhile), and
 * refreshUserTier() writes only if the row is still the one it computed from, so a newer tier is never overwritten.
 */
import { TIER_CACHE_MS, refreshUserTier, type Prisma, type PrismaClient, type ReadBalance, type TierEnv } from '@apecheck/db';
import type { Logger } from '../log';

export const TIERS_JOB = 'tiers-refresh';
/** hourly, at minute 7 */
export const TIERS_PATTERN = '7 * * * *';
export const SEEN_DAYS = 7;
/** Pro/Max users who haven't been seen lately: re-read this often */
export const PAID_IDLE_REFRESH_MS = 24 * 3600_000;
const MAX_USERS = 5000;
const PARALLEL = 4;

export interface TierRefreshDeps {
  env: TierEnv;
  prisma: PrismaClient;
  readBalance: ReadBalance;
  log: Logger;
}

export interface TierRefreshResult {
  users: number;
  read: number;
  failed: number;
  changed: number;
  /** due when the job started, but refreshed by someone else (a sign-in, a wallet link) before the job reached them */
  skipped: number;
}

export async function refreshTiers(deps: TierRefreshDeps, now = Date.now()): Promise<TierRefreshResult> {
  const { prisma, log } = deps;
  const t0 = Date.now();
  const stale = new Date(now - TIER_CACHE_MS);
  const idleStale = new Date(now - PAID_IDLE_REFRESH_MS);
  const due: Prisma.UserWhereInput = {
    OR: [
      { lastSeenAt: { gte: new Date(now - SEEN_DAYS * 86_400_000) }, OR: [{ tierCheckedAt: null }, { tierCheckedAt: { lt: stale } }] },
      { tier: { in: ['PRO', 'MAX'] }, OR: [{ tierCheckedAt: null }, { tierCheckedAt: { lt: idleStale } }] },
    ],
  };
  const ids = await prisma.user.findMany({
    where: due,
    orderBy: { tierCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: MAX_USERS,
    select: { id: true },
  });
  const res: TierRefreshResult = { users: ids.length, read: 0, failed: 0, changed: 0, skipped: 0 };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, ids.length) }, async () => {
      while (next < ids.length) {
        const { id } = ids[next++];
        try {
          // the user as stored now, not as loaded when the job started: a wallet may have been linked since, and a
          // sign-in may have stored a newer tier (then they are no longer due)
          const u = await prisma.user.findFirst({ where: { id, ...due } });
          if (!u) {
            res.skipped++;
            continue;
          }
          // `now` moved on by the time the job has run, so the stored check time is when this read happened
          const at = new Date(now + (Date.now() - t0));
          const { user, result } = await refreshUserTier(prisma, u, { env: deps.env, readBalance: deps.readBalance, now: at });
          if (result.read) res.read++;
          if (result.failed) res.failed++;
          if (result.expired) log.warn(`user ${id}: balance unreadable for over a day since the last good read, holding dropped`);
          if (user.tier !== u.tier) {
            res.changed++;
            log.info(`user ${id}: ${u.tier} → ${user.tier}`);
          }
        } catch (e) {
          res.failed++;
          log.warn(`tier of user ${id} not refreshed`, e);
        }
      }
    }),
  );
  if (ids.length) {
    const skipped = res.skipped ? `, ${res.skipped} refreshed meanwhile` : '';
    log.info(`tier refresh: ${ids.length} users, ${res.read} balances read, ${res.failed} failed, ${res.changed} tiers changed${skipped}`);
  }
  return res;
}
