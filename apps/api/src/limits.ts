/**
 * Per-user limits (M3), next to the per-IP route limits of @fastify/rate-limit (plugins/rateLimit.ts):
 *  - `slidingLimit`: at most `max` hits in any `windowMs` (a Redis sorted set of hit times), e.g. ASKS_PER_HOUR and
 *    the per-user bursts on every signed-in route. A hit can be given back (`release`) when the action didn't happen.
 *  - `dailyLimit`: a counter per UTC day (NOTES_PER_DAY), reset at 00:00 UTC like the credits.
 * Both are atomic Lua scripts. A Redis failure lets the request through (a limiter hiccup must not take routes down).
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { nextUtcMidnight, utcDay } from '@apecheck/core';
import { ApiError, MSG } from './errors';
import { RATE } from './plugins/rateLimit';

const SLIDING_LUA = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local n = redis.call('ZCARD', KEYS[1])
if n >= max then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, n, tonumber(oldest[2] or now)}
end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return {1, n + 1, 0}
`;

const DAILY_LUA = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v >= tonumber(ARGV[1]) then return {0, v} end
v = redis.call('INCR', KEYS[1])
redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[2]))
return {1, v}
`;

export interface LimitHit {
  ok: boolean;
  /** hits in the window after this one (or at refusal) */
  count: number;
  /** ms until a slot frees up (0 when ok) */
  retryAfterMs: number;
  /** give this hit back (the action didn't happen) */
  release(): Promise<void>;
}

const noop = async () => undefined;

export async function slidingLimit(redis: Redis, key: string, max: number, windowMs: number, now = Date.now()): Promise<LimitHit> {
  const member = `${now}:${randomBytes(6).toString('hex')}`;
  try {
    const [ok, count, oldest] = (await redis.eval(SLIDING_LUA, 1, key, now, windowMs, max, member)) as [number, number, number];
    if (Number(ok) !== 1) return { ok: false, count: Number(count), retryAfterMs: Math.max(0, Number(oldest) + windowMs - now), release: noop };
    return {
      ok: true,
      count: Number(count),
      retryAfterMs: 0,
      release: async () => {
        await redis.zrem(key, member).catch(() => undefined);
      },
    };
  } catch {
    return { ok: true, count: 0, retryAfterMs: 0, release: noop };
  }
}

export async function dailyLimit(redis: Redis, key: string, max: number, now = new Date()): Promise<LimitHit> {
  const expireAt = Math.floor(nextUtcMidnight(now).getTime() / 1000) + 3600;
  try {
    const [ok, count] = (await redis.eval(DAILY_LUA, 1, key, max, expireAt)) as [number, number];
    if (Number(ok) !== 1) return { ok: false, count: Number(count), retryAfterMs: nextUtcMidnight(now).getTime() - now.getTime(), release: noop };
    return {
      ok: true,
      count: Number(count),
      retryAfterMs: 0,
      release: async () => {
        await redis.decr(key).catch(() => undefined);
      },
    };
  } catch {
    return { ok: true, count: 0, retryAfterMs: 0, release: noop };
  }
}

export const userLimitKey = (name: string, userId: string) => `rl:user:${name}:${userId}`;
export const dailyKey = (name: string, userId: string, now = new Date()) => `${name}:${utcDay(now)}:user:${userId}`;

/** Per-user burst limits of the signed-in routes (per minute), on top of their per-IP route limits. */
export const USER_RATE = {
  verify: 10,
  xLink: 10,
  asks: 10,
  notes: 5,
  helpful: 60,
  watch: 60,
  watchlist: 60,
  notifications: 60,
  notificationsRead: 30,
  // M4: key and webhook management (session only), test pings
  keys: 30,
  webhooks: 30,
  webhookTest: 10,
  // M4: reading a webhook's deliveries (the /api page looks again while a test ping is on its way): a bucket of its
  // own, as wide as the route's per-IP limit, so waiting on pings can never lock Add, Enable or Delete
  webhookDeliveries: 60,
  // M4: checks started with an API key (POST /v1/checks with a key, MCP run_check), one bucket per account whatever
  // the key, IP or transport: the per-IP limit of POST /v1/checks, which run_check never passes through
  apiChecks: RATE.createCheckPerMin,
} as const;

/** One per-minute burst hit for this user on `name`; 429 rate_limited when over. */
export async function userBurst(redis: Redis, name: keyof typeof USER_RATE, userId: string, message: string = MSG.rateLimited): Promise<void> {
  const hit = await slidingLimit(redis, userLimitKey(name, userId), USER_RATE[name], 60_000);
  if (!hit.ok) throw new ApiError(429, 'rate_limited', message);
}
