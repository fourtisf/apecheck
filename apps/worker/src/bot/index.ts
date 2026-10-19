/**
 * worker-bot (HANDOFF §7): polls the bot's mentions every BOT_POLL_SECONDS, handles each one (handle.ts) and posts
 * the replies queued on "bot-replies" (reply.ts).
 *
 *  - X not configured (no mentions()/reply(), OAuth 1.0a keys or X_BOT_USER_ID): one warning, then idle, alive for PM2.
 *  - One active bot: a Redis lock (bot:lock, SET NX EX, refreshed on every poll). A second process stands by, and
 *    takes over when the lock expires; only the holder polls and posts, so two processes never double-reply.
 *  - since_id in Redis (bot:since_id), moved forward only after a whole batch was stored and handled; on a cold
 *    start, the newest tweet id among the handled mentions (below a mention whose handling was cut off).
 *  - Lost reply jobs (sweepLostReplies): mentions QUEUED for a reply that no job will send are queued again on taking
 *    over the lock and every SWEEP_EVERY_MS.
 */
import { randomBytes } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { BOT_REPLY_JOB_OPTIONS, CHECK_JOB_OPTIONS, PRIORITY, QUEUES, type BotReplyJob, type CheckJob, type Env } from '@apecheck/core';
import { prisma as defaultPrisma, type PrismaClient } from '@apecheck/db';
import { createHttp, createX, type XPost, type XSource } from '@apecheck/sources';
import { createAi } from '../ai';
import type { AiAdapter } from '../ai/types';
import { createLogger, type Logger } from '../log';
import { bullConnection, publisherConnection } from '../redis';
import { MentionBusyError, handleMention, type BotDeps, type MentionOutcome } from './handle';
import { compareIds } from './mention';
import { processReply, replyBackoff, type ReplyOutcome } from './reply';

export { handleMention, processMention, storeMention, botIdentity, isTransientError, MentionBusyError, type BotDeps, type MentionOutcome } from './handle';
export { processReply, cardPng, isRetryable, replyBackoff, type ReplyOutcome } from './reply';
export { resolveBotTarget, type BotResolution } from './resolve';
export { composeReply, composeFollowUp, composePointer, HELP_TEXT, FAILED_TEXT, PRO_POINTER_TEXT } from './compose';

export const SINCE_KEY = 'bot:since_id';
export const LOCK_KEY = 'bot:lock';

/**
 * Why the bot can't run, or null when X is set up for it: the adapter's mentions()/reply() and the four OAuth 1.0a
 * user keys of the bot account (read from env only). X_BOT_USER_ID is recommended, not required: without it the
 * adapter looks the id up once, and the bot recognises its own posts by X_BOT_HANDLE.
 */
export function botConfigProblem(_env: Env, x: XSource): string | null {
  const missing: string[] = [];
  if (typeof x.mentions !== 'function' || typeof x.reply !== 'function') missing.push('the X adapter has no mentions()/reply()');
  if (!x.canPost) missing.push('X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET');
  return missing.length ? `X bot not configured (${missing.join('; ')} missing): worker-bot idles` : null;
}

/**
 * since_id for the next mentions() call: Redis, else (cold start) the newest stored mention that was handled — or
 * just below the oldest one still RECEIVED (its handling was cut off), so that one is read and handled again.
 */
export async function currentSinceId(deps: Pick<BotDeps, 'redis' | 'prisma'>): Promise<string | null> {
  const fromRedis = await deps.redis.get(SINCE_KEY);
  if (fromRedis && /^\d{1,25}$/.test(fromRedis)) return fromRedis;
  const [handled] = await deps.prisma.$queryRaw<{ tweetId: string }[]>`
    SELECT "tweetId" FROM "BotMention" WHERE "tweetId" ~ '^[0-9]{1,25}$' AND "status" <> 'RECEIVED'
    ORDER BY length("tweetId") DESC, "tweetId" DESC LIMIT 1`;
  const [cutOff] = await deps.prisma.$queryRaw<{ tweetId: string }[]>`
    SELECT "tweetId" FROM "BotMention" WHERE "tweetId" ~ '^[0-9]{1,25}$' AND "status" = 'RECEIVED'
    ORDER BY length("tweetId") ASC, "tweetId" ASC LIMIT 1`;
  let since: string | null = handled?.tweetId ?? null;
  if (cutOff && (!since || compareIds(cutOff.tweetId, since) <= 0)) {
    const below = BigInt(cutOff.tweetId) - 1n;
    since = below > 0n ? String(below) : null;
  }
  return since;
}

export interface PollResult {
  sinceId: string | null;
  /** since_id stored after this poll (unchanged when the batch was cut short) */
  nextSinceId: string | null;
  outcomes: { tweetId: string; outcome: MentionOutcome }[];
}

/**
 * One poll: mentions newer than since_id, oldest first, each stored then handled. `keepGoing` (the lock check) can
 * stop the batch; a stop or a database error while storing keeps since_id where it was, so the rest is read again
 * (and what was already stored is skipped).
 */
export async function pollOnce(deps: BotDeps, keepGoing: () => Promise<boolean> = async () => true): Promise<PollResult> {
  const since = await currentSinceId(deps);
  const { posts, newestId } = await deps.x.mentions!(since);
  const sorted = [...posts].filter((p): p is XPost => !!p && typeof p.id === 'string').sort((a, b) => compareIds(a.id, b.id));
  const outcomes: PollResult['outcomes'] = [];
  let complete = true;
  for (const post of sorted) {
    if (since && compareIds(post.id, since) <= 0) continue;
    if (!(await keepGoing())) {
      complete = false;
      break;
    }
    try {
      outcomes.push({ tweetId: post.id, outcome: await handleMention(deps, post) });
    } catch (e) {
      // the mention could not be stored, or its handling hit a transient error, or another handler holds it: read
      // it again next poll (it is handled then, never answered twice)
      if (e instanceof MentionBusyError) deps.log.info(`${e.message}; since_id kept`);
      else deps.log.error(`mention ${post.id} could not be stored or handled; since_id kept`, e);
      complete = false;
      break;
    }
  }
  let next = since;
  if (complete && newestId && (!since || compareIds(newestId, since) > 0)) {
    await deps.redis.set(SINCE_KEY, newestId);
    next = newestId;
  }
  return { sinceId: since, nextSinceId: next, outcomes };
}

/** QUEUED at least this long without a reply job: the job was lost (sweepLostReplies). */
export const SWEEP_AFTER_MS = 5 * 60_000;
/** how often the active worker-bot looks for lost reply jobs */
export const SWEEP_EVERY_MS = 5 * 60_000;
/** older mentions are not swept (they would be answered far too late) */
const SWEEP_MAX_AGE_MS = 24 * 3600_000;
/** a mention re-queued this many times and still QUEUED is given up (FAILED) */
const SWEEP_MAX_TIMES = 3;
/** BullMQ states of a reply job that will still run */
const LIVE_JOB = new Set(['waiting', 'wait', 'delayed', 'active', 'prioritized', 'waiting-children']);
const sweptKey = (mentionId: string) => `bot:swept:${mentionId}`;

/** The "bot-replies" queue as the sweep needs it (jobId = mention id). */
export interface ReplyJobs {
  /** BullMQ state of the mention's reply job; null when there is none */
  state(mentionId: string): Promise<string | null>;
  /** add the job again, first removing a finished (failed / completed) one: a plain add with that id is a no-op */
  readd(mentionId: string): Promise<void>;
}

/**
 * Mentions waiting for a reply that no job will ever send: QUEUED for SWEEP_AFTER_MS and either a help / follow-up
 * reply or linked to a check that is DONE or FAILED, with no waiting, delayed or running reply job. That happens
 * when the process died between marking a mention QUEUED and enqueueing its reply, when Stage F could not enqueue
 * (Redis hiccup), when worker-checks died between saving a check and enqueueing, or when the job failed for good on
 * an error the job itself didn't handle. Their reply jobs are queued again — safe: the reply job posts only for a
 * QUEUED mention and records an earlier post (bot:posted / bot:posting) instead of posting twice. Returns the ids.
 */
export async function sweepLostReplies(deps: Pick<BotDeps, 'prisma' | 'redis' | 'log'>, jobs: ReplyJobs, now = Date.now()): Promise<string[]> {
  const rows = await deps.prisma.botMention.findMany({
    where: {
      status: 'QUEUED',
      createdAt: { lt: new Date(now - SWEEP_AFTER_MS), gt: new Date(now - SWEEP_MAX_AGE_MS) },
      OR: [{ kind: { in: ['help', 'followup'] } }, { check: { is: { status: { in: ['DONE', 'FAILED'] } } } }],
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: { id: true, tweetId: true },
  });
  const requeued: string[] = [];
  for (const m of rows) {
    const state = await jobs.state(m.id);
    if (state && LIVE_JOB.has(state)) continue;
    const times = await deps.redis.incr(sweptKey(m.id));
    await deps.redis.expire(sweptKey(m.id), 2 * 86400);
    if (times > SWEEP_MAX_TIMES) {
      deps.log.warn(`mention ${m.tweetId}: reply job lost ${SWEEP_MAX_TIMES} times; given up`);
      await deps.prisma.botMention.updateMany({
        where: { id: m.id, status: 'QUEUED' },
        data: { status: 'FAILED', ignoreReason: 'the reply could not be sent (its job kept failing)' },
      });
      continue;
    }
    await jobs.readd(m.id);
    requeued.push(m.id);
  }
  return requeued;
}

const LOCK_LUA = `
local v = redis.call('GET', KEYS[1])
if v == ARGV[1] then redis.call('EXPIRE', KEYS[1], ARGV[2]) return 1 end
if not v then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) return 1 end
return 0`;
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export interface BotWorkerOptions {
  env: Env;
  prisma?: PrismaClient;
  /** default: the X adapter of @apecheck/sources (only X: the bot needs no other source) */
  x?: XSource;
  ai?: AiAdapter;
  log?: Logger;
  fetchCard?: BotDeps['fetchCard'];
  now?: () => number;
  /** default BOT_POLL_SECONDS */
  pollMs?: number;
  /** poll on a timer (default true); tests call tick() themselves */
  autoPoll?: boolean;
  /** reply concurrency (default 2) */
  replyConcurrency?: number;
}

export interface BotWorkerHandle {
  /** idle: X not configured; standby: another process holds the lock; active: polling and posting */
  readonly state: 'idle' | 'standby' | 'active';
  /** null when idle */
  readonly deps: BotDeps | null;
  /** one lock check + poll (what the timer runs); null when not active */
  tick(): Promise<PollResult | null>;
  /** sweepLostReplies() now (what the timer runs every SWEEP_EVERY_MS while active); [] when not active */
  sweep(): Promise<string[]>;
  close(): Promise<void>;
}

export async function startBotWorker(opts: BotWorkerOptions): Promise<BotWorkerHandle> {
  const { env } = opts;
  const log = opts.log ?? createLogger('bot');
  const x = opts.x ?? createX(env, createHttp(env));
  const problem = botConfigProblem(env, x);
  if (problem) {
    log.warn(problem);
    // keep the event loop alive so PM2 shows the process online instead of restart-looping it
    const keepAlive = setInterval(() => undefined, 1 << 30);
    return {
      state: 'idle',
      deps: null,
      tick: async () => null,
      sweep: async () => [],
      close: async () => clearInterval(keepAlive),
    };
  }

  if (!env.X_BOT_USER_ID) log.warn(`X_BOT_USER_ID not set: the bot's own posts are recognised by its handle @${env.X_BOT_HANDLE} only`);

  const bull: Redis = bullConnection(env.REDIS_URL);
  const pub: Redis = publisherConnection(env.REDIS_URL);
  const checks = new Queue<CheckJob>(QUEUES.checks, { connection: bull });
  const replies = new Queue<BotReplyJob>(QUEUES.botReplies, { connection: bull });
  const deps: BotDeps = {
    env,
    prisma: opts.prisma ?? defaultPrisma,
    redis: pub,
    x,
    ai: opts.ai ?? createAi(env),
    log,
    fetchCard: opts.fetchCard,
    now: opts.now,
    enqueueCheck: async checkId => {
      await checks.add('check', { checkId }, { jobId: checkId, priority: PRIORITY.bot, ...CHECK_JOB_OPTIONS });
    },
    enqueueReply: async mentionId => {
      await replies.add('reply', { mentionId }, { jobId: mentionId, ...BOT_REPLY_JOB_OPTIONS });
    },
  };

  const worker = new Worker<BotReplyJob, ReplyOutcome>(
    QUEUES.botReplies,
    async (job: Job<BotReplyJob>) => processReply(deps, job.data?.mentionId, { attemptsMade: job.attemptsMade, attempts: job.opts.attempts ?? 1 }),
    { connection: bull, concurrency: Math.max(1, opts.replyConcurrency ?? 2), autorun: false, settings: { backoffStrategy: (made: number, type?: string, err?: Error) => replyBackoff(made, type, err) } },
  );
  worker.on('failed', (job, err) => log.warn(`reply job ${job?.id ?? '?'} attempt ${job?.attemptsMade ?? '?'} failed: ${err.message}`));
  worker.on('error', err => log.error('reply worker error', err));

  const pollMs = Math.max(1000, opts.pollMs ?? env.BOT_POLL_SECONDS * 1000);
  const lockTtl = Math.max(60, Math.ceil((pollMs * 3) / 1000));
  const token = randomBytes(12).toString('hex');
  let state: 'standby' | 'active' = 'standby';
  let workerStarted = false;
  let warnedStandby = false;
  let lastLock = 0;

  const holdLock = async (): Promise<boolean> => {
    const ok = Number(await pub.eval(LOCK_LUA, 1, LOCK_KEY, token, lockTtl).catch(() => 0)) === 1;
    if (ok) lastLock = Date.now();
    return ok;
  };
  // lost reply jobs (sweepLostReplies): on taking over, then every SWEEP_EVERY_MS while active
  const jobs: ReplyJobs = {
    state: async id => {
      const job = await replies.getJob(id);
      return job ? await job.getState() : null;
    },
    readd: async id => {
      const job = await replies.getJob(id);
      if (job) await job.remove().catch(e => log.warn(`could not remove the finished reply job ${id}`, e));
      await deps.enqueueReply(id);
    },
  };
  let sweeping: Promise<string[]> | null = null;
  let closed = false;
  const sweep = (): Promise<string[]> => {
    if (sweeping) return sweeping;
    if (closed || state !== 'active') return Promise.resolve([]);
    const run = sweepLostReplies(deps, jobs)
      .then(ids => {
        if (ids.length) log.warn(`re-queued ${ids.length} lost reply job(s): ${ids.join(', ')}`);
        return ids;
      })
      .catch(e => {
        log.error('reply sweep failed', e);
        return [] as string[];
      })
      .finally(() => {
        sweeping = null;
      });
    sweeping = run;
    return run;
  };
  const sweepTimer = opts.autoPoll !== false ? setInterval(() => void sweep(), SWEEP_EVERY_MS) : null;
  sweepTimer?.unref();

  const becomeActive = () => {
    if (state === 'active') return;
    state = 'active';
    warnedStandby = false;
    if (!workerStarted) {
      workerStarted = true;
      void worker.run().catch(e => log.error('reply worker stopped', e));
    } else worker.resume();
    log.info(`active: polling @${env.X_BOT_HANDLE}'s mentions every ${pollMs / 1000}s (AI: ${deps.ai.mode}, links ${env.BOT_INCLUDE_LINK ? 'on' : 'off'})`);
    if (opts.autoPoll !== false) void sweep();
  };
  const becomeStandby = async (why: string) => {
    if (state === 'active') {
      log.error(`${why}: stopping until the lock is free again`);
      await worker.pause(true).catch(() => undefined);
    } else if (!warnedStandby) log.info(`${why}: standing by`);
    warnedStandby = true;
    state = 'standby';
  };

  let ticking: Promise<PollResult | null> | null = null;
  const tick = (): Promise<PollResult | null> => {
    if (ticking) return ticking;
    const run = (async () => {
      try {
        if (closed) return null;
        if (!(await holdLock())) {
          await becomeStandby('another worker-bot holds the bot lock');
          return null;
        }
        becomeActive();
        // refresh the lock while a long batch is handled; stop the batch if it was lost
        const keepGoing = async () => !closed && (Date.now() - lastLock < (lockTtl * 1000) / 3 || (await holdLock()));
        return await pollOnce(deps, keepGoing);
      } catch (e) {
        log.error('poll failed', e);
        return null;
      }
    })();
    ticking = run;
    void run.finally(() => {
      if (ticking === run) ticking = null;
    });
    return run;
  };

  let timer: NodeJS.Timeout | null = null;
  const loop = async () => {
    await tick();
    if (!closed) timer = setTimeout(() => void loop(), pollMs);
  };
  if (opts.autoPoll !== false) void loop();

  let closing: Promise<void> | null = null;
  return {
    get state() {
      return state;
    },
    deps,
    tick,
    sweep,
    close: () =>
      (closing ??= (async () => {
        closed = true;
        if (timer) clearTimeout(timer);
        if (sweepTimer) clearInterval(sweepTimer);
        await ticking?.catch(() => undefined);
        await sweeping?.catch(() => undefined);
        await worker.close().catch(() => undefined);
        await pub.eval(RELEASE_LUA, 1, LOCK_KEY, token).catch(() => undefined);
        await checks.close().catch(() => undefined);
        await replies.close().catch(() => undefined);
        await pub.quit().catch(() => undefined);
        await bull.quit().catch(() => undefined);
      })()),
  };
}
