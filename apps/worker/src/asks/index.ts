/**
 * Queue "asks" (M3): follow-up questions asked on the site (POST /v1/checks/:id/asks). The API enqueues an AskJob and
 * waits up to 45 s for this worker's AskJobResult ({ askId }); it then reads the Ask row. worker-bot runs this
 * consumer (lightweight: no browser), also while the X bot itself idles. The bot's own follow-ups (bot/reply.ts)
 * use the same answerFromCheck().
 *
 *  - the answer comes from the check's stored data only (answer.ts), validated and clamped;
 *  - one transaction: the Ask {question, answer, askerId, askerHandle, via} and Check.asksCount + 1;
 *  - a job is answered once: a retry of the same job (a stalled worker) returns the Ask it already saved;
 *  - a job older than ASK_JOB_MAX_AGE_MS is dropped: the API answered 504 long ago and the asker may have asked again;
 *  - jobs that can never succeed (bad payload, unknown check, no finished report, expired) fail with BullMQ's
 *    UnrecoverableError and a message that starts with a code the API can map: "bad_request:", "not_found:",
 *    "no_report:", "expired:".
 */
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUES, type AskJob, type AskJobResult, type Env } from '@apecheck/core';
import { prisma as defaultPrisma, type PrismaClient } from '@apecheck/db';
import { createAi } from '../ai';
import type { AiAdapter } from '../ai/types';
import { createLogger, type Logger } from '../log';
import { pgText } from '../pipeline/pgsafe';
import { bullConnection, publisherConnection } from '../redis';
import type { RunningWorker } from '../worker';
import { answerFromCheck, cleanQuestion } from './answer';

export { answerFromCheck, cleanQuestion, safeAnswer, ANSWER_MAX, QUESTION_MAX } from './answer';

/** the API waits 45 s; a job still queued well after that is not answered any more */
export const ASK_JOB_MAX_AGE_MS = 2 * 60_000;
/** jobId → askId, so a re-run of the same job never saves a second Ask */
export const askDoneKey = (jobId: string) => `asks:done:${jobId}`;

export interface AskDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, 'get' | 'set'>;
  ai: AiAdapter;
  log: Logger;
  now?: () => number;
}

const fail = (code: string, why: string) => new UnrecoverableError(`${code}: ${why}`);

/** One AskJob → the saved Ask's id. Throws UnrecoverableError ("<code>: …") when it can't be answered. */
export async function processAsk(deps: AskDeps, data: AskJob, job: { id?: string | null; timestamp?: number } = {}): Promise<AskJobResult> {
  const now = deps.now ? deps.now() : Date.now();
  if (!data || typeof data.checkId !== 'string' || !data.checkId || typeof data.question !== 'string') throw fail('bad_request', 'malformed ask job');
  const question = cleanQuestion(data.question);
  if (!question) throw fail('bad_request', 'empty question');
  if (job.timestamp && now - job.timestamp > ASK_JOB_MAX_AGE_MS) throw fail('expired', 'the question waited too long in the queue');

  if (job.id) {
    const done = await deps.redis.get(askDoneKey(job.id)).catch(() => null);
    if (done && (await deps.prisma.ask.findUnique({ where: { id: done }, select: { id: true } }))) return { askId: done };
  }

  // the API passes the internal Check.id; a shortId is accepted too
  const check = await deps.prisma.check.findFirst({ where: { OR: [{ id: data.checkId }, { shortId: data.checkId }] }, select: { id: true, status: true } });
  if (!check) throw fail('not_found', 'no such check');
  if (check.status !== 'DONE') throw fail('no_report', 'the check has not finished');

  const res = await answerFromCheck(deps, check.id, question);
  if (!res) throw fail('no_report', 'the check has no report to answer from');

  const askerId = typeof data.userId === 'string' && data.userId
    ? ((await deps.prisma.user.findUnique({ where: { id: data.userId }, select: { id: true } }))?.id ?? null)
    : null;
  const askerHandle = typeof data.askerHandle === 'string' ? pgText(data.askerHandle.replace(/^[@＠]+/, '').trim()).slice(0, 64) || null : null;
  const via = data.via === 'bot' ? 'BOT' : 'WEB';

  const ask = await deps.prisma.$transaction(async tx => {
    const a = await tx.ask.create({ data: { checkId: check.id, question, answer: res.answer, askerId, askerHandle, via }, select: { id: true } });
    await tx.check.update({ where: { id: check.id }, data: { asksCount: { increment: 1 } } });
    return a;
  });
  if (job.id) await deps.redis.set(askDoneKey(job.id), ask.id, 'EX', 3600).catch(() => undefined);
  deps.log.info(`answered a ${via === 'BOT' ? 'bot' : 'site'} question on check ${check.id}: ask ${ask.id}`);
  return { askId: ask.id };
}

export interface AsksWorkerOptions {
  env: Env;
  prisma?: PrismaClient;
  ai?: AiAdapter;
  log?: Logger;
  /** parallel questions (model calls); default 4 */
  concurrency?: number;
  now?: () => number;
}

export interface AsksWorkerHandle extends RunningWorker {
  worker: Worker<AskJob, AskJobResult>;
  deps: AskDeps;
}

export async function startAsksWorker(opts: AsksWorkerOptions): Promise<AsksWorkerHandle> {
  const { env } = opts;
  const log = opts.log ?? createLogger('asks');
  const bull = bullConnection(env.REDIS_URL);
  const pub = publisherConnection(env.REDIS_URL);
  const deps: AskDeps = { prisma: opts.prisma ?? defaultPrisma, redis: pub, ai: opts.ai ?? createAi(env), log, now: opts.now };
  const worker = new Worker<AskJob, AskJobResult>(
    QUEUES.asks,
    async (job: Job<AskJob>) => processAsk(deps, job.data, { id: job.id ?? null, timestamp: job.timestamp }),
    // a model answer takes up to ~30 s: keep the lock well above that
    { connection: bull, concurrency: Math.max(1, opts.concurrency ?? 4), lockDuration: 90_000 },
  );
  worker.on('failed', (job, err) => log.warn(`ask job ${job?.id ?? '?'} failed: ${err.message}`));
  worker.on('error', err => log.error('asks worker error', err));
  log.info(`answering follow-up questions on "${QUEUES.asks}" (AI: ${deps.ai.mode})`);
  let closing: Promise<void> | null = null;
  return {
    worker,
    deps,
    close: () =>
      (closing ??= (async () => {
        await worker.close().catch(() => undefined);
        await pub.quit().catch(() => undefined);
        await bull.quit().catch(() => undefined);
      })()),
  };
}
