/**
 * Bot limits (HANDOFF §7): per X account per hour — BOT_USER_HOURLY for free users, BOT_PRO_USER_HOURLY for Pro/Max
 * (User.tier through User.xUserId, linked in M3) — and BOT_HOURLY_CAP for the whole bot. Fixed UTC-hour windows in
 * Redis.
 *
 * A mention is counted when it is accepted for a reply, not when the reply goes out: a check takes minutes, and a
 * burst of tags must not all pass while the counters still read 0. Each accepted mention gets exactly one reply, so
 * the counters are the replies of the hour (sent or on their way). Ignored mentions are never counted. The posted
 * replies are counted separately (bot:replied:<hour>) when they go out.
 */
import type { Redis } from 'ioredis';

export const hourBucket = (now: number) => new Date(now).toISOString().slice(0, 13).replace(/[-T]/g, ''); // YYYYMMDDHH
export const userHourKey = (authorId: string, now: number) => `bot:hourly:user:${authorId}:${hourBucket(now)}`;
export const allHourKey = (now: number) => `bot:hourly:all:${hourBucket(now)}`;
export const repliedHourKey = (now: number) => `bot:replied:${hourBucket(now)}`;

// both counters move together or not at all: 1 = user over limit, 2 = bot over cap, 0 = counted
const RESERVE_LUA = `
local u = tonumber(redis.call('GET', KEYS[1]) or '0')
local a = tonumber(redis.call('GET', KEYS[2]) or '0')
if u >= tonumber(ARGV[1]) then return 1 end
if a >= tonumber(ARGV[2]) then return 2 end
redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], 7200)
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 7200)
return 0`;

export type ReserveResult = { ok: true } | { ok: false; reason: 'user_limit' | 'global_limit' };

export async function reserveReply(redis: Redis, o: { authorId: string; userLimit: number; globalCap: number; now: number }): Promise<ReserveResult> {
  const r = Number(await redis.eval(RESERVE_LUA, 2, userHourKey(o.authorId, o.now), allHourKey(o.now), Math.max(0, o.userLimit), Math.max(0, o.globalCap)));
  if (r === 1) return { ok: false, reason: 'user_limit' };
  if (r === 2) return { ok: false, reason: 'global_limit' };
  return { ok: true };
}

/** A reply went out. */
export async function countReplied(redis: Redis, now: number): Promise<void> {
  const k = repliedHourKey(now);
  await redis.multi().incr(k).expire(k, 48 * 3600).exec();
}
