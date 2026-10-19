/**
 * Signed-in users (M3): tiers by holding (packages/db tiers.ts, balances read through @apecheck/sources), the
 * wallet sign-in / link rules, the $APECHECK quote and the MeDTO every page reads.
 */
import type { FastifyRequest } from 'fastify';
import {
  tokenLive,
  type MeDTO,
  type TierS,
  type UserDTO,
  type WalletChain,
} from '@apecheck/core';
import { Prisma, refreshUserTier, tokenChain, type ReadBalance, type TierResult, type User } from '@apecheck/db';
import { walletTokenBalance } from '@apecheck/sources';
import type { AppDeps } from './context';
import { getCredits, type CreditSubject } from './credits';
import { ApiError, MSG } from './errors';
import { clientIp } from './plugins/rateLimit';

/* ---------------- tiers ---------------- */

export function balanceReader(deps: Pick<AppDeps, 'sources'>): ReadBalance {
  return ({ chain, token, owner }) => walletTokenBalance(deps.sources, chain, token, owner);
}

/** one balance read per user at a time in this process (a page load fires several requests at once) */
const inflight = new Map<string, Promise<{ user: User; result: TierResult }>>();

/**
 * The viewer's tier now: the stored holding while it is younger than an hour, else a fresh balance read (a failed
 * read keeps the last value). `force` reads anyway (sign-in). Updates `request.viewer.user` with what was stored.
 */
export async function viewerTier(deps: AppDeps, request: FastifyRequest, opts: { force?: boolean } = {}): Promise<TierResult | null> {
  const user = request.viewer?.user;
  if (!user) return null;
  const key = `${user.id}:${opts.force ? 'force' : 'auto'}`;
  let p = inflight.get(key);
  if (!p) {
    p = refreshUserTier(deps.prisma, user, { env: deps.env, readBalance: balanceReader(deps), force: opts.force }).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const { user: stored, result } = await p;
  if (result.expired) request.log.warn(`user ${user.id}: balance unreadable for over a day since the last good read, holding dropped`);
  request.viewer = { ...request.viewer, user: stored };
  return result;
}

export function toUserDTO(deps: Pick<AppDeps, 'env'>, user: User, t: TierResult): UserDTO {
  return {
    id: user.id,
    evmAddress: user.evmAddress,
    solAddress: user.solAddress,
    xHandle: user.xHandle,
    tier: t.tier,
    holding: tokenLive(deps.env) ? t.holding : null,
    holder: t.holder,
  };
}

/** Who a credit is counted against: the signed-in user with their tier, else the anonymous cookie + IP. */
export function creditSubject(request: FastifyRequest, tier: TierS = 'free'): CreditSubject {
  const user = request.viewer?.user ?? null;
  return { sid: request.sid, ip: clientIp(request), userId: user?.id ?? null, tier: user ? tier : 'free' };
}

/* ---------------- $APECHECK quote ---------------- */

export const TOKEN_QUOTE_TTL_S = 60;
/** an unavailable quote is asked again sooner */
const TOKEN_QUOTE_MISS_TTL_S = 30;
const quoteKey = (chain: string, address: string) => `token:quote:${chain}:${address}`;
const quoteInflight = new Map<string, Promise<MeDTO['token']>>();

/** { usd, ch24 } from DexScreener, cached 60 s in Redis; null while the token isn't live or has no price. */
export async function tokenQuote(deps: Pick<AppDeps, 'env' | 'redis' | 'sources'>): Promise<MeDTO['token']> {
  const { env, redis, sources } = deps;
  const chain = tokenChain(env);
  if (!tokenLive(env) || !chain) return null;
  const key = quoteKey(chain, env.TOKEN_ADDRESS!);
  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    try {
      return (JSON.parse(cached) as { q: MeDTO['token'] }).q ?? null;
    } catch {
      // fall through to a fresh read
    }
  }
  let p = quoteInflight.get(key);
  if (!p) {
    p = (async () => {
      const info = await sources.dex.token(chain, env.TOKEN_ADDRESS!).catch(() => null);
      const usd = info?.priceUsd;
      const q = usd != null && Number.isFinite(usd) && usd > 0 ? { usd, ch24: info?.ch24 != null && Number.isFinite(info.ch24) ? info.ch24 : null } : null;
      await redis.set(key, JSON.stringify({ q }), 'EX', q ? TOKEN_QUOTE_TTL_S : TOKEN_QUOTE_MISS_TTL_S).catch(() => undefined);
      return q;
    })().finally(() => quoteInflight.delete(key));
    quoteInflight.set(key, p);
  }
  return p;
}

/* ---------------- /v1/me ---------------- */

export async function unreadCount(deps: Pick<AppDeps, 'prisma'>, userId: string): Promise<number> {
  return deps.prisma.notification.count({ where: { userId, readAt: null } });
}

export async function buildMe(deps: AppDeps, request: FastifyRequest, opts: { tier?: TierResult | null } = {}): Promise<MeDTO> {
  const { env, redis } = deps;
  const t = opts.tier !== undefined ? opts.tier : await viewerTier(deps, request);
  const user = request.viewer?.user ?? null;
  const tier: TierS = user && t ? t.tier : 'free';
  const [c, token, unread] = await Promise.all([
    getCredits(redis, env, creditSubject(request, tier)),
    tokenQuote(deps).catch(() => null),
    user ? unreadCount(deps, user.id) : Promise.resolve(0),
  ]);
  const live = tokenLive(env);
  return {
    credits: c.credits,
    max: c.max,
    resetsAt: c.resetsAt.toISOString(),
    tier,
    tokenLive: live,
    proMinHold: live ? env.PRO_MIN_HOLD : null,
    maxMinHold: live ? env.MAX_MIN_HOLD : null,
    user: user && t ? toUserDTO(deps, user, t) : null,
    proChecksPerDay: env.PRO_CHECKS_PER_DAY,
    maxChecksPerDay: env.MAX_CHECKS_PER_DAY,
    token,
    xLinkAvailable: !!env.X_OAUTH2_CLIENT_ID,
    notificationsUnread: unread,
  };
}

/* ---------------- sign-in / link ---------------- */

const walletField = (chain: WalletChain) => (chain === 'evm' ? 'evmAddress' : 'solAddress') as 'evmAddress' | 'solAddress';
/** EVM addresses are stored lowercase (unique, case-insensitive in meaning); Solana base58 as is */
export const walletKey = (chain: WalletChain, address: string) => (chain === 'evm' ? address.toLowerCase() : address);

const byWallet = (chain: WalletChain, key: string): Prisma.UserWhereUniqueInput => (chain === 'evm' ? { evmAddress: key } : { solAddress: key });

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

async function userForWallet(deps: AppDeps, chain: WalletChain, key: string): Promise<User> {
  const field = walletField(chain);
  const found = await deps.prisma.user.findUnique({ where: byWallet(chain, key) });
  if (found) return found;
  try {
    return await deps.prisma.user.create({ data: { [field]: key } });
  } catch (e) {
    // two sign-ins of a new wallet at once: the other one created it
    if (!isUniqueViolation(e)) throw e;
    return deps.prisma.user.findUniqueOrThrow({ where: byWallet(chain, key) });
  }
}

/**
 * The user a verified wallet signs in as:
 *  - signed out → the wallet's user (created on first sign-in);
 *  - signed in, the wallet already theirs → the same user;
 *  - signed in without a wallet of this chain → the wallet is linked to them (409 wallet_taken when another user has it);
 *  - signed in with a different wallet of this chain → a switch: the new wallet's own user (MetaMask account change).
 */
export async function signInWallet(deps: AppDeps, request: FastifyRequest, chain: WalletChain, address: string): Promise<{ user: User; linked: boolean }> {
  const field = walletField(chain);
  const key = walletKey(chain, address);
  const current = request.viewer?.user ?? null;
  if (!current) return { user: await userForWallet(deps, chain, key), linked: false };
  if (current[field] === key) return { user: current, linked: false };
  if (current[field]) return { user: await userForWallet(deps, chain, key), linked: false };

  const owner = await deps.prisma.user.findUnique({ where: byWallet(chain, key), select: { id: true } });
  if (owner && owner.id !== current.id) throw new ApiError(409, 'wallet_taken', MSG.walletTaken);
  try {
    const user = await deps.prisma.user.update({ where: { id: current.id }, data: { [field]: key, tierCheckedAt: null } });
    return { user, linked: true };
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError(409, 'wallet_taken', MSG.walletTaken);
    throw e;
  }
}
