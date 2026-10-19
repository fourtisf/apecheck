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
  asks: 'asks',
} as const;

/** queue "checks", job name "check", jobId = checkId (dedupes double submits) */
export interface CheckJob { checkId: string }
/** queue "bot-replies" (M2) */
export interface BotReplyJob { mentionId: string }
/** queue "asks" (M3): the API enqueues a follow-up question and waits for the worker's answer (job return value). */
export interface AskJob { checkId: string; question: string; userId: string | null; askerHandle: string | null; via: 'web' | 'bot' }
export interface AskJobResult { askId: string }
/** queue "rechecks" (M3): change detection for watched targets; Max watchers get an automatic re-check */
export interface RecheckJob { targetId: string }

/** queue "webhooks" (M4) */
export interface WebhookJob { webhookId: string; event: 'check.completed' | 'watch.changed'; checkId: string }

/** BullMQ priorities: lower number = earlier. Pro/Max users get the priority queue. */
export const PRIORITY = { max: 1, pro: 2, free: 5, bot: 5, recheck: 8 } as const;

/**
 * Options of every "check" job (API and bot; jobId = checkId). The worker throws only when the database fails while
 * it claims the check (runCheck catches everything after that), so a retry never re-runs stages; the last failure
 * marks the check FAILED.
 */
export const CHECK_JOB_OPTIONS = {
  removeOnComplete: { count: 2000, age: 24 * 3600 },
  removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

/**
 * Options of every "reply" job on bot-replies (worker-checks' Stage F and worker-bot; jobId = BotMention.id, so a
 * mention is queued at most once). Posting is retried when X answers 429/5xx (max 3 attempts) with worker-bot's
 * "x-reply" backoff: exponential from `delay`, or until X's rate-limit reset when it named one (capped).
 */
export const BOT_REPLY_JOB_OPTIONS = {
  removeOnComplete: 1000,
  removeOnFail: 1000,
  attempts: 3,
  backoff: { type: 'x-reply', delay: 30_000 },
};

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
/** Cookie holding the signed-in user session (M3): signed, value = session id; the session lives in Redis. */
export const SESSION_COOKIE = 'ac_session';
export const sessionKey = (sessionId: string) => `session:${sessionId}`;
/** Sign-in nonces (single use, 10 min): value = JSON {chain, address, message} */
export const authNonceKey = (nonce: string) => `auth:nonce:${nonce}`;
/** X OAuth 2.0 PKCE state (10 min): value = JSON {userId, verifier} */
export const xOauthStateKey = (state: string) => `auth:x:${state}`;
export const SESSION_DAYS = 30;
