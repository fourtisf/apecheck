/**
 * Process boundaries: BullMQ queue names + job payloads and Redis channels/keys.
 * Producers and consumers both import from here so the names can't drift.
 */
import type { CheckStatusS, StepDTO } from './dto';

export const QUEUES = {
  checks: 'checks',
  botReplies: 'bot-replies',
  prices: 'prices',
  webhooks: 'webhooks',
  rechecks: 'rechecks',
} as const;

/** queue "checks", job name "check", jobId = checkId (dedupes double submits) */
export interface CheckJob { checkId: string }
/** queue "bot-replies" (M2) */
export interface BotReplyJob { mentionId: string }
/** queue "webhooks" (M4) */
export interface WebhookJob { webhookId: string; event: 'check.completed' | 'watch.changed'; checkId: string }

/** BullMQ priorities: lower number = earlier. Pro/Max users get the priority queue. */
export const PRIORITY = { max: 1, pro: 2, free: 5, bot: 5, recheck: 8 } as const;

/** Redis pub/sub channel with every step of one check (internal Check.id, not shortId). */
export const checkChannel = (checkId: string) => `check:${checkId}`;
/** Redis pub/sub channel announcing checks starting/finishing (for /v1/live listeners). */
export const LIVE_CHANNEL = 'live';
/** Redis key holding the 0–1 progress of a running check (string number, TTL 1h). */
export const progressKey = (checkId: string) => `check:${checkId}:progress`;

export type CheckChannelMsg =
  | { type: 'step'; step: StepDTO; progress: number }
  | { type: 'status'; status: CheckStatusS; progress: number }
  | { type: 'done'; status: 'done' | 'failed' };

export type LiveChannelMsg = { type: 'start' | 'end'; checkId: string; shortId: string };

/** Anonymous credits (HANDOFF §8): counters per UTC day, per cookie id and per IP. */
export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
export const creditsKeySid = (sid: string, day = utcDay()) => `credits:${day}:sid:${sid}`;
export const creditsKeyIp = (ip: string, day = utcDay()) => `credits:${day}:ip:${ip}`;
export const creditsKeyUser = (userId: string, day = utcDay()) => `credits:${day}:user:${userId}`;
export function nextUtcMidnight(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/** Cookie holding the signed anonymous session id. */
export const SID_COOKIE = 'ac_sid';
/** Cookie holding the signed-in user session (M3). */
export const SESSION_COOKIE = 'ac_session';
