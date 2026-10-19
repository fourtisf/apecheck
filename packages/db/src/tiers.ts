/**
 * Tiers by token holding (HANDOFF §8), shared by the API (sign-in, /v1/me, gates) and the worker (bot limits for
 * X-linked users, watch re-checks). The balance reader is injected, so this package needs no data-source dependency:
 * the API passes `@apecheck/sources` walletTokenBalance(), tests pass a fake.
 *
 * Rules:
 *  - holding = TOKEN_ADDRESS balance on TOKEN_CHAIN summed over the user's linked wallets of that chain's family
 *    (the EVM wallet for an EVM token, the Solana wallet for an SPL token). Read on sign-in (`force`) and whenever the
 *    stored value is older than TIER_CACHE_MS (1 h).
 *  - tier: holding >= MAX_MIN_HOLD → max, >= PRO_MIN_HOLD → pro, else free. holder = holding > 0.
 *  - A failed read keeps the last stored holding and is retried after TIER_RETRY_MS (the stored check time is set so
 *    the cache runs out then), so an RPC outage neither drops anyone to Free nor hammers the RPC. That lasts at most
 *    TIER_STALE_MAX_MS after the last successful read (User.tierReadAt): past it the holding is dropped (Free, not a
 *    holder, unless overridden) until a read succeeds again, so someone who sold can't keep a paid tier by making
 *    their own reads fail (or just through a long outage).
 *  - While TOKEN_ADDRESS is empty the token isn't live: nobody is read, holding is null and everyone is Free…
 *  - …except wallets listed in TIER_OVERRIDES ("address:pro,address:max"; EVM compared case-insensitively), which get
 *    that tier and count as holders (team testing before launch). An override never lowers a tier from holdings.
 *  - A stored tier is only ever replaced by one computed from that same stored row (refreshUserTier's conditional
 *    write): the API (sign-in, wallet link, /v1/me) and the worker's hourly refresh run at the same time, and a tier
 *    computed from an older copy of the user (before a wallet was linked, or before a newer read was stored) must not
 *    overwrite the newer one, which the next hour would then trust.
 */
import { CHAINS, isChainKey, type ChainKey, type Env, type TierS } from '@apecheck/core';
import type { Prisma, PrismaClient, Tier, User } from '@prisma/client';

export type TierEnv = Pick<Env, 'TOKEN_CHAIN' | 'TOKEN_ADDRESS' | 'PRO_MIN_HOLD' | 'MAX_MIN_HOLD' | 'TIER_OVERRIDES'>;

/** how long a balance read is trusted */
export const TIER_CACHE_MS = 3600_000;
/** after a failed read, try again this soon */
export const TIER_RETRY_MS = 5 * 60_000;
/** failed reads keep the last holding this long after the last successful read, then it is dropped */
export const TIER_STALE_MAX_MS = 24 * 3600_000;

/** whole tokens `owner` holds of `token` on `chain`; null when it couldn't be read (never 0 for "unknown") */
export type ReadBalance = (wallet: { chain: ChainKey; token: string; owner: string }) => Promise<number | null>;

export interface TierUser {
  evmAddress: string | null;
  solAddress: string | null;
  tierCheckedAt: Date | null;
  /** User.tierReadAt: the last successful balance read (absent or null for a stored holding: tierCheckedAt stands in) */
  tierReadAt?: Date | null;
  /** User.holding (Decimal) */
  holding: Prisma.Decimal | number | string | null;
}

export interface TierResult {
  tier: TierS;
  /** whole tokens across the linked wallets on TOKEN_CHAIN; null while the token isn't live (or never read) */
  holding: number | null;
  /** may write community notes: holding > 0, or a tier override */
  holder: boolean;
  /** the tier TIER_OVERRIDES grants one of the user's wallets, if any */
  override: TierS | null;
  /** what User.tierCheckedAt should hold now */
  checkedAt: Date | null;
  /** what User.tierReadAt should hold now: the last successful read */
  readAt: Date | null;
  /** balances were read on this call */
  read: boolean;
  /** the read failed: `holding` is the last stored value (null once TIER_STALE_MAX_MS has passed since `readAt`) */
  failed: boolean;
  /** the read failed and the stored holding was dropped on this call: TIER_STALE_MAX_MS passed since the last good read */
  expired: boolean;
}

const RANK: Record<TierS, number> = { free: 0, pro: 1, max: 2 };
export const higherTier = (a: TierS, b: TierS | null | undefined): TierS => (b && RANK[b] > RANK[a] ? b : a);
export const tierToDb = (t: TierS): Tier => t.toUpperCase() as Tier;

const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const overrideKey = (address: string) => (isEvmAddress(address) ? address.toLowerCase() : address);

/** TIER_OVERRIDES entries ("address:pro" / "address:max", any case) → address key → tier. Malformed entries are skipped. */
export function parseTierOverrides(entries: readonly string[]): Map<string, TierS> {
  const out = new Map<string, TierS>();
  for (const raw of entries) {
    const entry = raw.trim();
    const at = entry.lastIndexOf(':');
    if (at <= 0) continue;
    const address = entry.slice(0, at).trim();
    const tier = entry.slice(at + 1).trim().toLowerCase();
    if (!address || (tier !== 'pro' && tier !== 'max')) continue;
    const key = overrideKey(address);
    out.set(key, higherTier(tier, out.get(key)));
  }
  return out;
}

/** The highest tier TIER_OVERRIDES gives any of the user's wallets, or null. */
export function overrideTier(env: Pick<Env, 'TIER_OVERRIDES'>, user: Pick<TierUser, 'evmAddress' | 'solAddress'>): TierS | null {
  if (!env.TIER_OVERRIDES.length) return null;
  const map = parseTierOverrides(env.TIER_OVERRIDES);
  let best: TierS | null = null;
  for (const w of [user.evmAddress, user.solAddress]) {
    const t = w ? map.get(overrideKey(w)) : undefined;
    if (t) best = higherTier(t, best);
  }
  return best;
}

/** Tier from a holding alone. */
export function tierFromHolding(env: Pick<Env, 'PRO_MIN_HOLD' | 'MAX_MIN_HOLD'>, holding: number | null): TierS {
  if (holding == null || !Number.isFinite(holding)) return 'free';
  if (holding >= env.MAX_MIN_HOLD) return 'max';
  if (holding >= env.PRO_MIN_HOLD) return 'pro';
  return 'free';
}

/** The token's chain (TOKEN_CHAIN), or null when it isn't a chain ApeCheck can read. */
export function tokenChain(env: Pick<Env, 'TOKEN_CHAIN'>): ChainKey | null {
  const c = env.TOKEN_CHAIN.trim().toLowerCase();
  return isChainKey(c) ? c : null;
}

/** The user's wallets that can hold the token: the EVM wallet for an EVM token, the Solana wallet for an SPL token. */
export function tokenWallets(env: Pick<Env, 'TOKEN_CHAIN'>, user: Pick<TierUser, 'evmAddress' | 'solAddress'>): string[] {
  const chain = tokenChain(env);
  if (!chain) return [];
  const family = CHAINS[chain].family;
  const w = family === 'evm' ? user.evmAddress : family === 'sol' ? user.solAddress : null;
  return w ? [w] : [];
}

const toNumber = (d: TierUser['holding']): number | null => {
  if (d == null) return null;
  const n = typeof d === 'number' ? d : Number(d.toString());
  return Number.isFinite(n) ? n : null;
};

export interface ComputeTierInput {
  env: TierEnv;
  user: TierUser;
  readBalance: ReadBalance;
  now?: Date;
  /** read balances even when the stored value is younger than TIER_CACHE_MS (sign-in) */
  force?: boolean;
}

type ResultExtra = Pick<TierResult, 'checkedAt' | 'readAt' | 'read' | 'failed'> & { expired?: boolean };

const resultFor = (env: TierEnv, override: TierS | null, holding: number | null, extra: ResultExtra): TierResult => ({
  tier: higherTier(tierFromHolding(env, holding), override),
  holding,
  holder: (holding ?? 0) > 0 || override != null,
  override,
  expired: false,
  ...extra,
});

/** What the stored row says, without reading any balance (the holding counts only while the token is live). */
export function storedTier(env: TierEnv, user: TierUser): TierResult {
  const live = !!env.TOKEN_ADDRESS && tokenChain(env) != null;
  return resultFor(env, overrideTier(env, user), live ? toNumber(user.holding) : null, {
    checkedAt: user.tierCheckedAt,
    readAt: user.tierReadAt ?? null,
    read: false,
    failed: false,
  });
}

/** The user's tier now. Reads balances only when the stored holding is stale (or `force`); never throws. */
export async function computeTier({ env, user, readBalance, now = new Date(), force = false }: ComputeTierInput): Promise<TierResult> {
  const override = overrideTier(env, user);
  const finish = (holding: number | null, extra: ResultExtra): TierResult => resultFor(env, override, holding, extra);
  const storedReadAt = user.tierReadAt ?? null;

  const chain = tokenChain(env);
  if (!env.TOKEN_ADDRESS || !chain) return storedTier(env, user);

  const stored = toNumber(user.holding);
  const age = user.tierCheckedAt ? now.getTime() - user.tierCheckedAt.getTime() : Infinity;
  if (!force && age >= 0 && age < TIER_CACHE_MS) return storedTier(env, user);

  const wallets = tokenWallets(env, user);
  // no wallet on the token's chain: nothing to read, holds nothing we can see
  if (!wallets.length) return finish(0, { checkedAt: now, readAt: now, read: false, failed: false });

  const token = env.TOKEN_ADDRESS;
  const values = await Promise.all(wallets.map(owner => readBalance({ chain, token, owner }).catch(() => null)));
  if (values.some(v => v == null || !Number.isFinite(v) || v < 0)) {
    // let the cache run out TIER_RETRY_MS from now so the read is retried then
    const retryAt = new Date(now.getTime() - TIER_CACHE_MS + TIER_RETRY_MS);
    const checkedAt = user.tierCheckedAt && user.tierCheckedAt > retryAt ? user.tierCheckedAt : retryAt;
    // the last good read; a holding stored without one (before tierReadAt existed) dates from tierCheckedAt, which is
    // pinned here before the retry above moves it on
    const readAt = storedReadAt ?? (stored != null ? user.tierCheckedAt : null);
    // keep the last value only while that read is recent: failed reads (an outage, or a wallet that makes its own
    // reads fail) must not keep a paid tier for good
    const recent = readAt != null && now.getTime() - readAt.getTime() < TIER_STALE_MAX_MS;
    const holding = recent ? stored : null;
    return finish(holding, { checkedAt, readAt, read: false, failed: true, expired: stored != null && holding == null });
  }
  const holding = (values as number[]).reduce((a, b) => a + b, 0);
  return finish(holding, { checkedAt: now, readAt: now, read: true, failed: false });
}

/** The User columns a TierResult maps to. */
export function tierUpdate(r: TierResult): Pick<Prisma.UserUpdateInput, 'tier' | 'holding' | 'tierCheckedAt' | 'tierReadAt'> {
  return { tier: tierToDb(r.tier), holding: r.holding, tierCheckedAt: r.checkedAt, tierReadAt: r.readAt };
}

/** a write that found the row changed since it was read gives up after this many attempts and returns the stored row */
const REFRESH_ATTEMPTS = 3;

/** The row exactly as `user` was read: a tier computed from it may replace the stored one only while all of this holds. */
function sameRowAs(user: User): Prisma.UserWhereInput {
  return {
    // the wallets the holding was read from (a link sets tierCheckedAt to null as well)
    evmAddress: user.evmAddress,
    solAddress: user.solAddress,
    // the stored tier it replaces: any other tier write since moved at least one of these
    tier: user.tier,
    holding: user.holding,
    tierCheckedAt: user.tierCheckedAt,
    tierReadAt: user.tierReadAt,
  };
}

const sameTime = (a: Date | null | undefined, b: Date | null | undefined) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * computeTier() for a stored user, writing User.tier / holding / tierCheckedAt / tierReadAt when they changed. Returns
 * the user as stored afterwards and the result. Never throws for a failed balance read (the result says `failed`).
 *
 * The write is conditional on the row still being the `user` it was computed from (same wallets, same stored tier):
 * the hourly job holds users it loaded minutes ago, and a request holds the user it loaded when it started, while a
 * wallet link or sign-in may store a newer tier meanwhile. When the row changed, nothing is written: a tier stored
 * after this call started (a sign-in's read, another refresh) stands and is returned; otherwise (a wallet was linked,
 * or an older write landed) the tier is worked out again from the row as stored now. After REFRESH_ATTEMPTS
 * conflicts the stored row is returned as is.
 */
export async function refreshUserTier(
  prisma: PrismaClient,
  user: User,
  opts: { env: TierEnv; readBalance: ReadBalance; now?: Date; force?: boolean },
): Promise<{ user: User; result: TierResult }> {
  const { env, readBalance, force } = opts;
  const t0 = Date.now();
  const startedAt = opts.now ?? new Date(t0);
  let current = user;
  for (let attempt = 1; ; attempt++) {
    // later attempts move the clock on by the time spent (from `now` when the caller gave one)
    const now = attempt === 1 ? startedAt : new Date(startedAt.getTime() + (Date.now() - t0));
    const result = await computeTier({ env, readBalance, user: current, now, force });
    const data = tierUpdate(result);
    const unchanged =
      current.tier === data.tier &&
      toNumber(current.holding) === result.holding &&
      sameTime(current.tierCheckedAt, result.checkedAt) &&
      sameTime(current.tierReadAt, result.readAt);
    if (unchanged) return { user: current, result };
    // one UPDATE … WHERE id AND <the row as read> RETURNING: atomic, and no row back when it changed (or is gone)
    const [updated] = await prisma.user.updateManyAndReturn({ where: { id: current.id, ...sameRowAs(current) }, data });
    if (updated) return { user: updated, result };
    const fresh = await prisma.user.findUnique({ where: { id: current.id } });
    if (!fresh) return { user: current, result };
    // stored since this call started, from the row as it was then (every tier write is conditional like this one):
    // as current as what this call computed, so it stands. A wallet link since sets tierCheckedAt to null instead.
    if (fresh.tierCheckedAt && fresh.tierCheckedAt.getTime() >= startedAt.getTime()) return { user: fresh, result: storedTier(env, fresh) };
    if (attempt >= REFRESH_ATTEMPTS) return { user: fresh, result: storedTier(env, fresh) };
    current = fresh;
  }
}
