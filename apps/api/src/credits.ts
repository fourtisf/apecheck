/**
 * Daily check credits (HANDOFF §8).
 *
 * Anonymous visitors: FREE_CHECKS_PER_DAY per UTC day, counted under BOTH the signed cookie id
 * and the IP. A check consumes from both; remaining = max − max(usedSid, usedIp). Clearing
 * cookies doesn't reset the IP counter and a shared IP doesn't let one cookie use more than max.
 *
 * Signed-in users (M3) are counted under their user id with their tier's limit: pass
 * `userId` and `tier` in the subject and nothing else changes.
 */
import type { Redis } from 'ioredis';
import { creditsKeyIp, creditsKeySid, creditsKeyUser, nextUtcMidnight, utcDay, type Env, type TierS } from '@apecheck/core';

export interface CreditSubject {
  sid: string;
  ip: string;
  /** M3: signed-in user; counts under the user key instead of sid + ip */
  userId?: string | null;
  tier?: TierS;
}

export interface CreditState {
  /** checks left today */
  credits: number;
  max: number;
  resetsAt: Date;
}

export interface ConsumeResult extends CreditState {
  ok: boolean;
}

export function creditLimit(env: Env, tier: TierS = 'free'): number {
  if (tier === 'max') return env.MAX_CHECKS_PER_DAY;
  if (tier === 'pro') return env.PRO_CHECKS_PER_DAY;
  return env.FREE_CHECKS_PER_DAY;
}

export function creditKeys(subject: CreditSubject, now = new Date()): string[] {
  const day = utcDay(now);
  if (subject.userId) return [creditsKeyUser(subject.userId, day)];
  return [creditsKeySid(subject.sid, day), creditsKeyIp(subject.ip, day)];
}

/** Counters live until the next 00:00 UTC plus an hour of slack for clock skew between processes. */
function expiresAtSec(now: Date): number {
  return Math.floor(nextUtcMidnight(now).getTime() / 1000) + 3600;
}

/**
 * Atomic check-and-increment over every key. Refuses (returns ok=0) when any counter is
 * already at the limit, so concurrent requests can never overspend.
 * Returns {ok, highestUsedAfter}.
 */
const CONSUME_LUA = `
local max = tonumber(ARGV[1])
local exp = tonumber(ARGV[2])
local used = 0
for i = 1, #KEYS do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > used then used = v end
end
if used >= max then return {0, used} end
used = 0
for i = 1, #KEYS do
  local v = redis.call('INCR', KEYS[i])
  redis.call('EXPIREAT', KEYS[i], exp)
  if v > used then used = v end
end
return {1, used}
`;

/** Give a credit back (the check could not be queued). Never drops below zero. */
const REFUND_LUA = `
for i = 1, #KEYS do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 0 then redis.call('DECR', KEYS[i]) end
end
return 1
`;

export async function getCredits(redis: Redis, env: Env, subject: CreditSubject, now = new Date()): Promise<CreditState> {
  const max = creditLimit(env, subject.tier);
  const keys = creditKeys(subject, now);
  const values = await redis.mget(...keys);
  const used = Math.max(0, ...values.map(v => Number.parseInt(v ?? '0', 10) || 0));
  return { credits: Math.max(0, max - used), max, resetsAt: nextUtcMidnight(now) };
}

export async function consumeCredit(redis: Redis, env: Env, subject: CreditSubject, now = new Date()): Promise<ConsumeResult> {
  const max = creditLimit(env, subject.tier);
  const keys = creditKeys(subject, now);
  const res = (await redis.eval(CONSUME_LUA, keys.length, ...keys, max, expiresAtSec(now))) as [number, number];
  const ok = Number(res[0]) === 1;
  const used = Number(res[1]) || 0;
  return { ok, credits: Math.max(0, max - used), max, resetsAt: nextUtcMidnight(now) };
}

export async function refundCredit(redis: Redis, subject: CreditSubject, now = new Date()): Promise<void> {
  const keys = creditKeys(subject, now);
  await redis.eval(REFUND_LUA, keys.length, ...keys);
}
