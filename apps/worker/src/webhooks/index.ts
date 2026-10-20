/**
 * Webhooks consumer (queue "webhooks", M4), hosted by worker-prices: light, no browser. One job per WebhookDelivery
 * (jobId = delivery id): Stage F / the failure paths queue check.completed (pipeline/save.ts afterFinish), the change
 * detector queues watch.changed (watch/recheck.ts), the API queues the "Send test" ping (WEBHOOK_PING_PRIORITY: every
 * event delivery waiting goes first). deliver.ts signs and POSTs.
 *
 * Fairness: every request holds Redis slots (deliverySlots) — its webhook's (one request in flight per webhook), its
 * owner's (PER_USER_IN_FLIGHT) and, for a ping, its owner's ping slot (one test in flight per user). A delivery whose
 * slot is taken goes back to the queue for a second or two (no attempt used, no worker slot held), so an endpoint that
 * accepts connections and never answers ties up one of the `concurrency` slots, not all of them, and one account's
 * test pings can't hold up anyone else's events.
 *
 * Retries: WEBHOOK_JOB_OPTIONS (6 attempts) with the "webhook" backoff (1 min, ×4 each, ~5.7 h from the first attempt
 * to the last). A repeatable "sweep" job (every 5 minutes):
 *  - queues again any delivery still pending after 5 minutes whose job is gone (a crash between writing the row and
 *    queuing it, a failed enqueue); one pending for more than a day, or with every attempt used, is marked failed
 *    instead. It reads the ids of every live job once and pages through all pending rows (deliveries waiting for a
 *    retry never hide a lost one behind them);
 *  - catches up check.completed deliveries that were never written (a database error after the check finished:
 *    missedCheckCompleted), for checks finished in the last CATCH_UP_SPAN_MS.
 * Any job on this queue that isn't the sweep is a WebhookJob.
 */
import { randomUUID } from 'node:crypto';
import { DelayedError, Queue, Worker, type Job, type JobType } from 'bullmq';
import type { Redis } from 'ioredis';
import { CHECK_JOINED_INDEX, CHECK_JOINERS_TTL_S, QUEUES, type Env, type WebhookJob } from '@apecheck/core';
import { prisma as defaultPrisma, type PrismaClient } from '@apecheck/db';
import { createSources, type Http, type Sources } from '@apecheck/sources';
import { createLogger, errText, type Logger } from '../log';
import { bullConnection } from '../redis';
import { NOTIFY_CHANGED } from '../watch/notify';
import type { RunningWorker } from '../worker';
import { WEBHOOK_TIMEOUT_MS, processDelivery, type DeliverDeps, type DeliveryOutcome } from './deliver';
import {
  EVENT_CHECK_COMPLETED,
  LINK_SLACK_MS,
  WEBHOOK_BACKOFF,
  WEBHOOK_DELIVER_JOB,
  WEBHOOK_JOB_OPTIONS,
  WEBHOOK_MAX_ATTEMPTS,
  checkCompletedDeliveries,
  enqueueDeliveries,
  readJoiners,
  webhookRetryDelayMs,
} from './events';

export * from './events';
export {
  buildPayload,
  processDelivery,
  hostOf,
  WEBHOOK_USER_AGENT,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_MAX_RESPONSE_BYTES,
  type DeliverDeps,
  type DeliveryOutcome,
  type DeliverySlotRequest,
} from './deliver';

export const WEBHOOK_SWEEP_JOB = 'sweep';
export const SWEEP_EVERY_MS = 5 * 60_000;
/** a pending delivery this old without a job was lost: queue it again */
export const SWEEP_MIN_AGE_MS = 5 * 60_000;
/** a pending delivery older than this (the retries span ~6 h) is given up instead */
export const SWEEP_GIVE_UP_MS = 24 * 3600_000;
/** deliveries queued again per sweep (the next sweep goes on from there) */
export const SWEEP_MAX = 500;
/** pending rows read per query, and looked at per sweep at most (the next sweep goes on from where this one stopped) */
export const SWEEP_PAGE = 2000;
export const SWEEP_SCAN_MAX = 20_000;
/** BullMQ states in which the job will still run (or is running) */
const ALIVE = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);
const ALIVE_TYPES: JobType[] = ['waiting', 'paused', 'delayed', 'active', 'prioritized', 'waiting-children'];
/** finished checks whose missing check.completed rows the sweep writes (a database error lasts minutes, not hours) */
export const CATCH_UP_SPAN_MS = 6 * 3600_000;
/** checks caught up per sweep */
export const CATCH_UP_MAX = 200;

/** requests in flight at once to one webhook (deliverySlots) */
export const PER_WEBHOOK_IN_FLIGHT = 1;
/** requests in flight at once to one user's webhooks, pings included */
export const PER_USER_IN_FLIGHT = 2;
/** test pings in flight at once per user */
export const PER_USER_PINGS_IN_FLIGHT = 1;
/** a slot frees itself this long after it was taken (a worker that died holding it): a request lasts WEBHOOK_TIMEOUT_MS */
export const SLOT_TTL_MS = 3 * WEBHOOK_TIMEOUT_MS;
export const slotKeys = {
  webhook: (webhookId: string) => `webhooks:slots:hook:${webhookId}`,
  user: (userId: string) => `webhooks:slots:user:${userId}`,
  ping: (userId: string) => `webhooks:slots:ping:${userId}`,
};
/** wait before a delivery whose slot was taken is tried again: 1–2 s */
export const busyDelayMs = (random: () => number = Math.random) => 1000 + Math.floor(1000 * random());

/** A failed attempt that BullMQ should retry (its message is what the delivery row says). */
export class WebhookRetry extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRetry';
  }
}

export interface WebhooksWorkerOptions {
  env: Env;
  prisma?: PrismaClient;
  sources?: Sources;
  /** default sources.http (createSources(env).http) */
  http?: Http;
  log?: Logger;
  /** deliveries sent in parallel (default 8) */
  concurrency?: number;
  /** wait before a retry after `attemptsMade` failed attempts (default webhookRetryDelayMs; tests shorten it) */
  retryDelayMs?: (attemptsMade: number) => number;
  /** default SWEEP_EVERY_MS; 0 = no repeatable sweep (tests call sweep()) */
  sweepEveryMs?: number;
  /** requests in flight at once per user (default PER_USER_IN_FLIGHT) */
  perUserInFlight?: number;
  /** wait before a delivery whose slot was taken is tried again (default busyDelayMs) */
  busyDelayMs?: () => number;
  now?: () => number;
}

export interface WebhooksWorkerHandle extends RunningWorker {
  queue: Queue<WebhookJob>;
  worker: Worker;
  deps: DeliverDeps;
  /** one sweep of lost deliveries now: how many were queued again */
  sweep(): Promise<number>;
  /** the sweep's check.completed catch-up now: for how many checks deliveries were written (missedCheckCompleted) */
  catchUp(): Promise<number>;
}

/* ---------------- slots ---------------- */

// KEYS: one sorted set per slot (member = holder token, score = when it frees itself); ARGV: token, ttl ms, then the
// limit of each key. All or nothing: the slots are taken together only when every one has room.
const ACQUIRE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[2])
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i + 2]) then return 0 end
end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], now + ttl, ARGV[1])
  redis.call('PEXPIRE', KEYS[i], ttl)
end
return 1
`;

/**
 * DeliverDeps.acquire backed by Redis (shared by every worker-prices process): the webhook's slot
 * (PER_WEBHOOK_IN_FLIGHT), its owner's (`perUser`) and, for a ping, its owner's ping slot (PER_USER_PINGS_IN_FLIGHT).
 * A slot frees itself after SLOT_TTL_MS. When Redis can't be asked the delivery goes ahead (the queue lives on the same
 * Redis: there is nothing to protect then).
 */
export function deliverySlots(redis: Pick<Redis, 'eval' | 'zrem'>, opts: { perUser?: number; log?: Logger } = {}): NonNullable<DeliverDeps['acquire']> {
  const perUser = Math.max(1, opts.perUser ?? PER_USER_IN_FLIGHT);
  return async ({ webhookId, userId, ping }) => {
    const slots: [string, number][] = [
      [slotKeys.webhook(webhookId), PER_WEBHOOK_IN_FLIGHT],
      [slotKeys.user(userId), perUser],
      ...(ping ? ([[slotKeys.ping(userId), PER_USER_PINGS_IN_FLIGHT]] as [string, number][]) : []),
    ];
    const token = randomUUID();
    let got: unknown;
    try {
      got = await redis.eval(ACQUIRE_LUA, slots.length, ...slots.map(x => x[0]), token, SLOT_TTL_MS, ...slots.map(x => x[1]));
    } catch (e) {
      opts.log?.warn(`webhook ${webhookId}: delivery slots unavailable, sending anyway: ${errText(e)}`);
      return async () => undefined;
    }
    if (Number(got) !== 1) return null;
    return async () => {
      await Promise.all(slots.map(([key]) => redis.zrem(key, token)));
    };
  };
}

/* ---------------- sweep: lost deliveries ---------------- */

/** Where a sweep stopped (it reached SWEEP_SCAN_MAX or SWEEP_MAX); null = start from the oldest pending row. */
export interface SweepState {
  cursor: { createdAt: Date; id: string } | null;
}

/**
 * Pending deliveries whose job is gone: queued again (or failed, when too old or out of attempts). Returns how many
 * were queued again. The ids of every live job are read once; then all pending rows older than SWEEP_MIN_AGE_MS are
 * paged through in (createdAt, id) order, so deliveries waiting for their retry never hide a lost one behind them.
 * A sweep that stops early (SWEEP_SCAN_MAX rows looked at, SWEEP_MAX queued again) leaves its place in `state` and the
 * next one goes on from there.
 */
export async function sweepLostDeliveries(
  deps: Pick<DeliverDeps, 'prisma' | 'log' | 'now'>,
  queue: Queue<WebhookJob>,
  state: SweepState = { cursor: null },
  limits: { page?: number; scanMax?: number; max?: number } = {},
): Promise<number> {
  const page = Math.max(1, limits.page ?? SWEEP_PAGE);
  const scanMax = Math.max(1, limits.scanMax ?? SWEEP_SCAN_MAX);
  const max = Math.max(1, limits.max ?? SWEEP_MAX);
  const now = deps.now ? deps.now() : Date.now();
  const cutoff = new Date(now - SWEEP_MIN_AGE_MS);
  const alive = new Set(await queue.getRanges(ALIVE_TYPES, 0, -1));
  let cursor = state.cursor;
  let seen = 0;
  let requeued = 0;
  let finished = false;
  scan: for (;;) {
    const rows = await deps.prisma.webhookDelivery.findMany({
      where: {
        status: 'pending',
        createdAt: { lt: cutoff },
        ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: page,
      select: { id: true, attempts: true, createdAt: true },
    });
    for (const r of rows) {
      cursor = { createdAt: r.createdAt, id: r.id };
      seen++;
      if (alive.has(r.id)) continue;
      // the ids were read before this page: a job queued since (Stage F again, another sweep) is left alone
      const job = await queue.getJob(r.id);
      const st = job ? await job.getState() : null;
      if (st && ALIVE.has(st)) continue;
      if (r.attempts >= WEBHOOK_MAX_ATTEMPTS || now - r.createdAt.getTime() > SWEEP_GIVE_UP_MS) {
        await deps.prisma.webhookDelivery.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'failed', error: 'Not delivered in time' } });
        continue;
      }
      if (job) await job.remove().catch(() => undefined);
      await queue.add(WEBHOOK_DELIVER_JOB, { deliveryId: r.id }, { jobId: r.id, ...WEBHOOK_JOB_OPTIONS });
      requeued++;
      if (requeued >= max) break scan;
    }
    if (rows.length < page) {
      finished = true;
      break;
    }
    if (seen >= scanMax) break;
  }
  state.cursor = finished ? null : cursor;
  if (requeued) deps.log.warn(`webhooks: ${requeued} lost deliver${requeued === 1 ? 'y' : 'ies'} queued again`);
  return requeued;
}

/* ---------------- sweep: check.completed never written ---------------- */

/**
 * Finished checks (DONE / FAILED, finished in [from, to)) owed a check.completed delivery that was never written: a
 * webhook that receives it (enabled, subscribed, Max owner, added before the check finished) of someone who asked for
 * it — its requester, a Max watcher whose automatic re-check it is (webhooks/events.ts), or one of `joined` (the
 * joiners of checks in CHECK_JOINED_INDEX) — has no row for it. Oldest first.
 */
export async function missedCheckCompleted(
  prisma: PrismaClient,
  from: Date,
  to: Date,
  joined: { checkId: string; userId: string }[] = [],
  limit = CATCH_UP_MAX,
): Promise<string[]> {
  // "finishedAt" / "createdAt" are timestamps without time zone holding UTC: bind ISO text and cast (a bound Date
  // would be compared in the session TimeZone)
  const slackS = LINK_SLACK_MS / 1000;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c."id"
    FROM "Check" c
    JOIN "Webhook" w ON w."disabledAt" IS NULL AND ${EVENT_CHECK_COMPLETED}::text = ANY(w."events") AND w."createdAt" <= c."finishedAt"
    JOIN "User" u ON u."id" = w."userId" AND u."tier" = 'MAX'
    WHERE c."status" IN ('DONE', 'FAILED')
      AND c."finishedAt" >= ${from.toISOString()}::timestamp AND c."finishedAt" < ${to.toISOString()}::timestamp
      AND (
        w."userId" = c."requesterId"
        OR (c."isPrivate" = false AND EXISTS (
          SELECT 1 FROM "Notification" n
          WHERE n."userId" = w."userId" AND n."checkId" = c."id" AND n."kind" = ${NOTIFY_CHANGED}
            AND n."createdAt" >= c."createdAt" - make_interval(secs => ${slackS}::double precision)
            AND n."createdAt" <= c."finishedAt" + make_interval(secs => ${slackS}::double precision)))
        OR (c."isPrivate" = false AND (c."id", w."userId") IN (
          SELECT j."checkId", j."userId" FROM unnest(${joined.map(j => j.checkId)}::text[], ${joined.map(j => j.userId)}::text[]) AS j("checkId", "userId")))
      )
      AND NOT EXISTS (
        SELECT 1 FROM "WebhookDelivery" d WHERE d."webhookId" = w."id" AND d."checkId" = c."id" AND d."event" = ${EVENT_CHECK_COMPLETED})
    GROUP BY c."id"
    ORDER BY MIN(c."finishedAt") ASC
    LIMIT ${limit}`;
  return rows.map(r => r.id);
}

/**
 * The sweep's catch-up (M4-CORR-3): writes and queues the check.completed deliveries of checks finished in the last
 * CATCH_UP_SPAN_MS (and at least SWEEP_MIN_AGE_MS ago: the check's own end writes them first) that afterFinish
 * couldn't write. Joiners come from Redis (CHECK_JOINED_INDEX, trimmed to CHECK_JOINERS_TTL_S here; a check leaves it
 * once it is finished and handled). Returns for how many checks deliveries were written.
 */
export async function catchUpCheckCompleted(
  deps: Pick<DeliverDeps, 'prisma' | 'log' | 'now'> & { redis?: Pick<Redis, 'zremrangebyscore' | 'zrange' | 'zrem' | 'smembers'> },
  queue: Queue<WebhookJob>,
): Promise<number> {
  const { prisma, log, redis } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const from = new Date(now - CATCH_UP_SPAN_MS);
  const to = new Date(now - SWEEP_MIN_AGE_MS);

  // checks that Max users joined (oldest first), with their joiners; finished ones leave the index once handled
  let joinedIds: string[] = [];
  const joined: { checkId: string; userId: string }[] = [];
  const handled: string[] = [];
  if (redis) {
    try {
      await redis.zremrangebyscore(CHECK_JOINED_INDEX, '-inf', now - CHECK_JOINERS_TTL_S * 1000);
      joinedIds = await redis.zrange(CHECK_JOINED_INDEX, 0, CATCH_UP_MAX - 1);
    } catch (e) {
      log.warn(`webhooks: could not read the joined checks: ${errText(e)}`);
    }
  }
  if (joinedIds.length) {
    const done = await prisma.check.findMany({
      where: { id: { in: joinedIds }, status: { in: ['DONE', 'FAILED'] }, finishedAt: { lt: to } },
      select: { id: true },
    });
    for (const c of done) {
      handled.push(c.id);
      for (const userId of await readJoiners(redis, c.id, log)) joined.push({ checkId: c.id, userId });
    }
    // gone from the database (the check was deleted): nothing will ever be owed; one still running stays (at most
    // CHECK_JOINERS_TTL_S, trimmed above)
    const known = new Set((await prisma.check.findMany({ where: { id: { in: joinedIds } }, select: { id: true } })).map(c => c.id));
    for (const id of joinedIds) if (!known.has(id)) handled.push(id);
  }

  const ids = await missedCheckCompleted(prisma, from, to, joined);
  let written = 0;
  const failed = new Set<string>();
  for (const id of ids) {
    try {
      const pending = await checkCompletedDeliveries(prisma, id, { joiners: joined.filter(j => j.checkId === id).map(j => j.userId) });
      if (pending.length) {
        written++;
        await enqueueDeliveries(queue, pending).catch(e => log.warn(`webhooks: could not queue the caught-up deliveries of check ${id} (the next sweep does): ${errText(e)}`));
      }
    } catch (e) {
      failed.add(id);
      log.warn(`webhooks: could not catch up the check.completed deliveries of check ${id}: ${errText(e)}`);
    }
  }
  if (redis && handled.length) {
    const drop = handled.filter(id => !failed.has(id));
    if (drop.length) await redis.zrem(CHECK_JOINED_INDEX, ...drop).catch(() => undefined);
  }
  if (written) log.warn(`webhooks: wrote the missing check.completed deliveries of ${written} check(s)`);
  return written;
}

export async function startWebhooksWorker(opts: WebhooksWorkerOptions): Promise<WebhooksWorkerHandle> {
  const { env } = opts;
  const log = opts.log ?? createLogger('webhooks');
  const bull = bullConnection(env.REDIS_URL);
  const queue = new Queue<WebhookJob>(QUEUES.webhooks, { connection: bull });
  const deps: DeliverDeps = {
    env,
    prisma: opts.prisma ?? defaultPrisma,
    http: opts.http ?? (opts.sources ?? createSources(env)).http,
    log,
    now: opts.now,
    acquire: deliverySlots(bull, { perUser: opts.perUserInFlight, log }),
  };
  const sweepState: SweepState = { cursor: null };
  const sweep = () => sweepLostDeliveries(deps, queue, sweepState);
  const catchUp = () => catchUpCheckCompleted({ ...deps, redis: bull }, queue);
  const every = opts.sweepEveryMs ?? SWEEP_EVERY_MS;
  if (every > 0) {
    await queue.upsertJobScheduler('webhooks-sweep', { every }, { name: WEBHOOK_SWEEP_JOB, data: {} as WebhookJob, opts: { removeOnComplete: 20, removeOnFail: 20 } });
  }
  const retryDelay = opts.retryDelayMs ?? ((made: number) => webhookRetryDelayMs(made));
  const busyDelay = opts.busyDelayMs ?? (() => busyDelayMs());
  const worker = new Worker<WebhookJob, DeliveryOutcome | { requeued: number; caughtUp: number }>(
    QUEUES.webhooks,
    async (job: Job<WebhookJob>, token?: string) => {
      if (job.name === WEBHOOK_SWEEP_JOB) {
        const requeued = await sweep();
        const caughtUp = await catchUp().catch(e => {
          log.error('webhooks: the check.completed catch-up failed', e);
          return 0;
        });
        return { requeued, caughtUp };
      }
      const id = job.data?.deliveryId;
      if (typeof id !== 'string' || !id) return { status: 'skipped', reason: 'no delivery id' };
      const out = await processDelivery(deps, id, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 });
      if (out.status === 'busy') {
        // another request to this webhook (or too many of its owner's) is in flight: back to the queue for a moment,
        // without using an attempt or holding this slot
        await job.moveToDelayed(Date.now() + busyDelay(), token);
        throw new DelayedError();
      }
      if (out.status === 'retry') throw new WebhookRetry(out.error);
      return out;
    },
    {
      connection: bull,
      concurrency: Math.max(1, opts.concurrency ?? 8),
      lockDuration: 60_000,
      settings: { backoffStrategy: (made: number, type?: string) => (type === WEBHOOK_BACKOFF ? retryDelay(made) : 60_000) },
    },
  );
  worker.on('failed', (job, err) => {
    if (err instanceof WebhookRetry || err.name === 'WebhookRetry') return; // a retry, already logged
    log.error(`webhook job ${job?.name ?? '?'} ${job?.id ?? ''} failed`, err);
  });
  worker.on('error', err => log.error('webhooks worker error', err));
  log.info(
    `webhooks: delivering (concurrency ${Math.max(1, opts.concurrency ?? 8)}, one request per webhook and ${Math.max(1, opts.perUserInFlight ?? PER_USER_IN_FLIGHT)} per user at a time, ${WEBHOOK_MAX_ATTEMPTS} attempts each)${every > 0 ? `; lost-delivery sweep every ${every / 60_000} minutes` : ''}`,
  );
  let closing: Promise<void> | null = null;
  return {
    queue,
    worker,
    deps,
    sweep,
    catchUp,
    close: () =>
      (closing ??= (async () => {
        await worker.close().catch(() => undefined);
        await queue.close().catch(() => undefined);
        await bull.quit().catch(() => undefined);
      })()),
  };
}
