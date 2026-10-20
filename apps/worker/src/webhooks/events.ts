/**
 * Webhook events (HANDOFF §9, M4: Max "API, MCP and webhooks"): which WebhookDelivery rows an event makes. Each row
 * gets one job on QUEUES.webhooks (jobId = delivery id); deliver.ts signs and POSTs it.
 *
 *  check.completed — a check finished (DONE or FAILED: Stage F, a failure, the stuck-check recovery, a job re-run that
 *                    finds it finished) that the webhook's owner asked for — and only those:
 *                      - its requester (Check.requesterId: via the site, the API or MCP);
 *                      - a Max user whose request joined it while it was running (the API answered with this check's id
 *                        instead of starting another: the Redis set checkJoinersKey, see readJoiners);
 *                      - every Max watcher it ran for as their automatic re-check (their "changed" notification links
 *                        it, watch/recheck.ts; also when that re-check joined a run already in progress).
 *                    A private check is its requester's alone, so it only ever reaches its owner's webhooks.
 *  watch.changed   — the change detector wrote a "changed" notification for the webhook's owner (watch/recheck.ts);
 *                    the rows are written in the same transaction as the notifications.
 *  ping            — POST /v1/webhooks/:id/test (the API writes that row and queues it, WEBHOOK_PING_PRIORITY).
 *
 * Only webhooks that are enabled (disabledAt null), subscribed to the event and owned by a user who is Max right now
 * (User.tier, kept current by the tier refresh): someone who dropped below Max stops receiving events.
 *
 * Delivery ids are derived from (webhook, event, check or notification), so finishing the same check twice never makes
 * a second delivery; a row whose job got lost is queued again by the sweep (index.ts), and check.completed rows that
 * were never written (a database error after the check finished) are written by its catch-up (missedCheckCompleted).
 */
import { createHash } from 'node:crypto';
import type { JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { checkJoinersKey, type WebhookEvent, type WebhookJob } from '@apecheck/core';
import type { Prisma, PrismaClient } from '@apecheck/db';
import { errText, type Logger } from '../log';
import { NOTIFY_CHANGED } from '../watch/notify';

export const EVENT_CHECK_COMPLETED = 'check.completed' satisfies WebhookEvent;
export const EVENT_WATCH_CHANGED = 'watch.changed' satisfies WebhookEvent;
export const EVENT_PING = 'ping';

/** attempts per delivery: the first one plus 5 retries over ~6 h (webhookRetryDelayMs) */
export const WEBHOOK_MAX_ATTEMPTS = 6;
/** consecutive failed deliveries (each after all its attempts) that disable a webhook */
export const WEBHOOK_DISABLE_AFTER = 20;
/** BullMQ backoff type handled by the webhooks worker's backoffStrategy */
export const WEBHOOK_BACKOFF = 'webhook';
/** job name of a delivery on QUEUES.webhooks (any job that isn't the sweep is a WebhookJob) */
export const WEBHOOK_DELIVER_JOB = 'deliver';

/** Options of every delivery job (jobId = WebhookDelivery.id, so a delivery is queued at most once at a time). */
export const WEBHOOK_JOB_OPTIONS = {
  attempts: WEBHOOK_MAX_ATTEMPTS,
  backoff: { type: WEBHOOK_BACKOFF },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
} satisfies JobsOptions;

/**
 * Wait before the next attempt after `attemptsMade` failed ones: 1 min, 4 min, 16 min, 64 min, ~4.3 h (×4 each), so the
 * sixth and last attempt is ~5.7 h after the first. Up to 10 % jitter, so deliveries that failed together (a receiver
 * that was down) don't all come back in the same second.
 */
export function webhookRetryDelayMs(attemptsMade: number, random: () => number = Math.random): number {
  const n = Math.min(Math.max(1, Math.floor(attemptsMade)), WEBHOOK_MAX_ATTEMPTS - 1);
  const base = 60_000 * 4 ** (n - 1);
  return Math.round(base * (1 + 0.1 * random()));
}

/** "wd_" + 24 hex: the same (webhook, event, check / notification) always gives the same delivery id. */
export function deliveryIdFor(webhookId: string, event: string, ref: string): string {
  return 'wd_' + createHash('sha256').update(`${webhookId}|${event}|${ref}`).digest('hex').slice(0, 24);
}

type Db = PrismaClient | Prisma.TransactionClient;

/** The user's webhooks that receive `event` now: enabled, subscribed, owner on Max. */
function receivers(db: Db, userIds: string[], event: WebhookEvent, createdBy?: Date) {
  return db.webhook.findMany({
    where: {
      userId: { in: userIds },
      disabledAt: null,
      events: { has: event },
      user: { tier: 'MAX' },
      // a webhook added after the event happened doesn't get it (e.g. a later re-run of a finished check's job)
      ...(createdBy ? { createdAt: { lte: createdBy } } : {}),
    },
    select: { id: true, userId: true },
  });
}

/**
 * The "changed" alert that links an automatic re-check is written moments before the re-check is created, or (a run
 * already in progress was joined) after that run was created and before it finished: it is looked for within the
 * check's lifetime widened by this much (clock skew, a slow alert transaction), so the (userId, createdAt) index of
 * Notification serves the lookup instead of every notification of every subscriber.
 */
export const LINK_SLACK_MS = 60 * 60_000;

/**
 * Max users whose request joined this check while it was running (checkJoinersKey, written by the API). A Redis
 * failure is logged and counts as none: the requester's deliveries still go out, and the sweep's catch-up
 * (missedCheckCompleted) asks again later.
 */
export async function readJoiners(redis: Pick<Redis, 'smembers'> | undefined, checkId: string, log?: Pick<Logger, 'warn'>): Promise<string[]> {
  if (!redis) return [];
  try {
    return (await redis.smembers(checkJoinersKey(checkId))).filter(u => typeof u === 'string' && u.length > 0);
  } catch (e) {
    log?.warn(`could not read who joined check ${checkId}: ${errText(e)}`);
    return [];
  }
}

/**
 * The users a finished check's check.completed goes to (see the header): its requester, then, for a public check,
 * the given joiners and the Max watchers whose automatic re-check it is. Only users who could receive it at all (an
 * enabled check.completed webhook, Max) are looked up among the watchers.
 */
async function completedReceivers(
  db: Db,
  c: { id: string; requesterId: string | null; isPrivate: boolean; createdAt: Date; finishedAt: Date | null },
  joiners: string[],
): Promise<string[]> {
  const users = new Set<string>();
  if (c.requesterId) users.add(c.requesterId);
  // a private check is its requester's alone (no one else can join it: findReusableCheck only reuses someone's own
  // private run for them, and an automatic re-check is always public)
  if (c.isPrivate) return [...users];
  for (const u of joiners) users.add(u);
  const subscribed = await db.webhook.findMany({
    where: { disabledAt: null, events: { has: EVENT_CHECK_COMPLETED }, user: { tier: 'MAX' } },
    select: { userId: true },
    distinct: ['userId'],
  });
  const candidates = subscribed.map(s => s.userId).filter(u => !users.has(u));
  if (candidates.length) {
    const end = (c.finishedAt ?? c.createdAt).getTime() + LINK_SLACK_MS;
    const linked = await db.notification.findMany({
      where: {
        userId: { in: candidates },
        checkId: c.id,
        kind: NOTIFY_CHANGED,
        createdAt: { gte: new Date(c.createdAt.getTime() - LINK_SLACK_MS), lte: new Date(end) },
      },
      select: { userId: true },
    });
    for (const n of linked) users.add(n.userId);
  }
  return [...users];
}

const isFkError = (e: unknown) => (e as { code?: unknown } | null)?.code === 'P2003';

/**
 * check.completed for a finished check: one delivery per receiving webhook of everyone who asked for it (see the
 * header; `joiners` from readJoiners). Returns the ids of the deliveries still pending (new ones, and ones an earlier
 * call made whose job may have been lost: queuing them again is harmless, jobId = delivery id and deliver.ts skips any
 * that is no longer pending). Safe to call any number of times.
 */
export async function checkCompletedDeliveries(prisma: PrismaClient, checkId: string, opts: { joiners?: string[] } = {}): Promise<string[]> {
  const c = await prisma.check.findUnique({
    where: { id: checkId },
    select: { id: true, status: true, requesterId: true, isPrivate: true, createdAt: true, finishedAt: true },
  });
  if (!c || (c.status !== 'DONE' && c.status !== 'FAILED')) return [];
  const users = await completedReceivers(prisma, c, opts.joiners ?? []);
  if (!users.length) return [];
  const write = async () => {
    const hooks = await receivers(prisma, users, EVENT_CHECK_COMPLETED, c.finishedAt ?? undefined);
    const rows = hooks.map(h => ({ id: deliveryIdFor(h.id, EVENT_CHECK_COMPLETED, c.id), webhookId: h.id, event: EVENT_CHECK_COMPLETED, checkId: c.id }));
    if (rows.length) await prisma.webhookDelivery.createMany({ data: rows, skipDuplicates: true });
    return rows;
  };
  let rows: Awaited<ReturnType<typeof write>>;
  try {
    rows = await write();
  } catch (e) {
    // a webhook deleted between reading the receivers and the insert fails the whole insert: read them again, once,
    // so the other webhooks still get theirs
    if (!isFkError(e)) throw e;
    rows = await write();
  }
  if (!rows.length) return [];
  const pending = await prisma.webhookDelivery.findMany({ where: { id: { in: rows.map(r => r.id) }, status: 'pending' }, select: { id: true } });
  return pending.map(p => p.id);
}

/**
 * watch.changed for the "changed" notifications just written (inside the transaction that writes them, so an alert and
 * its webhooks exist together or not at all). One delivery per receiving webhook of each notified user. Returns the
 * new delivery ids, to queue once the transaction has committed.
 */
export async function watchChangedDeliveries(tx: Db, notifications: { id: string; userId: string }[], targetId: string): Promise<string[]> {
  if (!notifications.length) return [];
  const byUser = new Map(notifications.map(n => [n.userId, n.id]));
  const hooks = await receivers(tx, [...byUser.keys()], EVENT_WATCH_CHANGED);
  if (!hooks.length) return [];
  const rows = hooks.map(h => ({
    id: deliveryIdFor(h.id, EVENT_WATCH_CHANGED, byUser.get(h.userId)!),
    webhookId: h.id,
    event: EVENT_WATCH_CHANGED,
    targetId,
  }));
  await tx.webhookDelivery.createMany({ data: rows, skipDuplicates: true });
  return rows.map(r => r.id);
}

/** Queue deliveries (jobId = delivery id: one already queued, delayed for a retry or running is left alone). */
export async function enqueueDeliveries(queue: Queue<WebhookJob>, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await queue.addBulk(ids.map(id => ({ name: WEBHOOK_DELIVER_JOB, data: { deliveryId: id }, opts: { jobId: id, ...WEBHOOK_JOB_OPTIONS } })));
}
