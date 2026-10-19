/**
 * Follow-up questions on the site (M3, Pro/Max). The API never answers itself: it puts an AskJob on queue "asks",
 * the worker answers from the stored check (Ask row, Check.asksCount + 1) and returns { askId }, and the API waits
 * for that up to AskBroker.waitMs (45 s) through the process's one QueueEvents listener.
 *
 * Double submits: the same user asking the same question (case and spacing ignored) about the same check within
 * 60 s gets the same answer: the first request's job is awaited again (or its stored answer returned) instead of
 * asking twice. Redis `ask:idem:<user>:<check>:<hash>` = the job id, then `done:<askId>` once answered.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Job, Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUES, type AskJob, type AskJobResult, type Env } from '@apecheck/core';
import type { AppDeps, AskBroker } from './context';
import { ApiError, MSG, asksPerHourMessage } from './errors';
import { slidingLimit, userLimitKey } from './limits';

export const ASK_WAIT_MS = 45_000;
export const ASK_IDEM_TTL_S = 60;
/** how long a second submit waits for the first one's job to be added */
const JOB_APPEAR_MS = 3_000;
const JOB_APPEAR_POLL_MS = 50;
export const ASK_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 3600, count: 2000 },
  removeOnFail: { age: 24 * 3600, count: 2000 },
};

/** Lazily connected producer + QueueEvents on REDIS_URL (one of each per process). */
export function createAskBroker(env: Pick<Env, 'REDIS_URL'>, opts: { waitMs?: number } = {}): AskBroker {
  let queue: Queue<AskJob, AskJobResult> | null = null;
  let queueConn: Redis | null = null;
  let events: QueueEvents | null = null;
  let eventsConn: Redis | null = null;
  let ready: Promise<QueueEvents> | null = null;
  return {
    waitMs: opts.waitMs ?? ASK_WAIT_MS,
    queue() {
      if (!queue) {
        queueConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
        queue = new Queue<AskJob, AskJobResult>(QUEUES.asks, { connection: queueConn });
      }
      return queue;
    },
    events() {
      if (!ready) {
        eventsConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
        events = new QueueEvents(QUEUES.asks, { connection: eventsConn });
        ready = events.waitUntilReady().then(() => events!);
        ready.catch(() => {
          ready = null;
        });
      }
      return ready;
    },
    async close() {
      await events?.close().catch(() => undefined);
      await eventsConn?.quit().catch(() => undefined);
      await queue?.close().catch(() => undefined);
      await queueConn?.quit().catch(() => undefined);
    },
  };
}

/** what counts as "the same question" */
export const normaliseQuestion = (q: string) => q.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const idemKey = (userId: string, checkId: string, question: string) =>
  `ask:idem:${userId}:${checkId}:${createHash('sha256').update(normaliseQuestion(question)).digest('base64url').slice(0, 24)}`;

class AskWaitTimeout extends Error {}

/** Wait for the job's { askId }: ApiError 504 ask_timeout / 502 ask_failed otherwise. */
async function waitForAnswer(deps: AppDeps, job: Job<AskJob, AskJobResult>): Promise<string> {
  const events = await deps.asks.events();
  const ms = deps.asks.waitMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      // the library's own ttl only cleans its listeners up; this race decides
      job.waitUntilFinished(events, ms + 5_000) as Promise<AskJobResult>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AskWaitTimeout()), ms);
      }),
    ]);
    if (!result || typeof result.askId !== 'string') throw new ApiError(502, 'ask_failed', MSG.askFailed);
    return result.askId;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof AskWaitTimeout) {
      // nobody started it (worker down or busy): drop it rather than answer into the void later
      const state = await job.getState().catch(() => 'unknown');
      if (state === 'waiting' || state === 'prioritized' || state === 'delayed') await job.remove().catch(() => undefined);
      throw new ApiError(504, 'ask_timeout', MSG.askTimeout);
    }
    throw new ApiError(502, 'ask_failed', MSG.askFailed);
  } finally {
    clearTimeout(timer);
  }
}

export interface AskInput {
  /** internal Check.id */
  checkId: string;
  question: string;
  userId: string;
  askerHandle: string | null;
}

/**
 * Ask (or join the same ask made in the last minute) and return the Ask row id plus whether this request created it.
 * Spends one of the user's ASKS_PER_HOUR only when a new job is queued; gives it back when the job fails or can't be
 * queued.
 */
export async function askFollowUp(deps: AppDeps, input: AskInput): Promise<{ askId: string; created: boolean }> {
  const { redis, env } = deps;
  const key = idemKey(input.userId, input.checkId, input.question);
  const queue = deps.asks.queue();

  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = await redis.get(key);
    if (seen?.startsWith('done:')) return { askId: seen.slice(5), created: false };
    if (seen) {
      // the first request stores the job id a moment before it adds the job: give it that moment
      let job: Job<AskJob, AskJobResult> | undefined;
      for (let waited = 0; ; waited += JOB_APPEAR_POLL_MS) {
        job = await Job.fromId<AskJob, AskJobResult>(queue, seen);
        if (job || waited >= JOB_APPEAR_MS || (await redis.get(key)) !== seen) break;
        await new Promise(r => setTimeout(r, JOB_APPEAR_POLL_MS));
      }
      if (job) return { askId: await waitForAnswer(deps, job), created: false };
      // the earlier job never appeared or is gone (dropped after a timeout): ask again
      if ((await redis.get(key)) === seen) await redis.del(key);
      continue;
    }

    const jobId = `ask-${randomBytes(12).toString('base64url')}`;
    if ((await redis.set(key, jobId, 'EX', ASK_IDEM_TTL_S, 'NX')) !== 'OK') continue;

    const hit = await slidingLimit(redis, userLimitKey('asks-hour', input.userId), env.ASKS_PER_HOUR, 3600_000);
    if (!hit.ok) {
      await redis.del(key);
      throw new ApiError(429, 'rate_limited', asksPerHourMessage(env.ASKS_PER_HOUR));
    }

    let job: Job<AskJob, AskJobResult>;
    try {
      await deps.asks.events();
      job = await queue.add('ask', { checkId: input.checkId, question: input.question, userId: input.userId, askerHandle: input.askerHandle, via: 'web' }, { jobId, ...ASK_JOB_OPTIONS });
    } catch {
      await Promise.all([redis.del(key), hit.release()]).catch(() => undefined);
      throw new ApiError(503, 'queue_unavailable', MSG.askQueueDown);
    }
    try {
      const askId = await waitForAnswer(deps, job);
      await redis.set(key, `done:${askId}`, 'EX', ASK_IDEM_TTL_S).catch(() => undefined);
      return { askId, created: true };
    } catch (err) {
      const failed = err instanceof ApiError && err.code === 'ask_failed';
      // a timed-out job that never started was removed: that question wasn't asked either
      const dropped = err instanceof ApiError && err.code === 'ask_timeout' && !(await Job.fromId(queue, jobId).catch(() => null));
      if (failed || dropped) await Promise.all([redis.del(key), hit.release()]).catch(() => undefined);
      throw err;
    }
  }
  throw new ApiError(503, 'queue_unavailable', MSG.askQueueDown);
}
