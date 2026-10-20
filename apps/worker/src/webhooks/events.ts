/**
 * Webhook events (HANDOFF §9, M4: Max "API, MCP and webhooks"): which WebhookDelivery rows an event makes. Each row
 * gets one job on QUEUES.webhooks (jobId = delivery id); deliver.ts signs and POSTs it.
 *
 *  check.completed — a check finished (DONE or FAILED: Stage F, a failure, the stuck-check recovery, a job re-run that
 *                    finds it finished) that the webhook's owner requested (Check.requesterId: via the site, the API or
 *                    MCP, and the Max automatic re-check started on their behalf) — and only those. A private check is
 *                    its requester's alone, so it only ever reaches its owner's webhooks.
 *  watch.changed   — the change detector wrote a "changed" notification for the webhook's owner (watch/recheck.ts);
 *                    the rows are written in the same transaction as the notifications.
 *  ping            — POST /v1/webhooks/:id/test (the API writes that row and queues it).
 *
 * Only webhooks that are enabled (disabledAt null), subscribed to the event and owned by a user who is Max right now
 * (User.tier, kept current by the tier refresh): someone who dropped below Max stops receiving events.
 *
 * Delivery ids are derived from (webhook, event, check or notification), so finishing the same check twice never makes
 * a second delivery; a row whose job got lost is queued again by the sweep (index.ts).
 */
import { createHash } from 'node:crypto';
import type { JobsOptions, Queue } from 'bullmq';
import type { WebhookEvent, WebhookJob } from '@apecheck/core';
import type { Prisma, PrismaClient } from '@apecheck/db';

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
 * check.completed for a finished check: one delivery per receiving webhook of its requester. Returns the ids of the
 * deliveries still pending (new ones, and ones an earlier call made whose job may have been lost: queuing them again
 * is harmless, jobId = delivery id and deliver.ts skips any that is no longer pending). Safe to call any number of times.
 */
export async function checkCompletedDeliveries(prisma: PrismaClient, checkId: string): Promise<string[]> {
  const c = await prisma.check.findUnique({ where: { id: checkId }, select: { id: true, status: true, requesterId: true, finishedAt: true } });
  if (!c?.requesterId || (c.status !== 'DONE' && c.status !== 'FAILED')) return [];
  const hooks = await receivers(prisma, [c.requesterId], EVENT_CHECK_COMPLETED, c.finishedAt ?? undefined);
  if (!hooks.length) return [];
  const rows = hooks.map(h => ({ id: deliveryIdFor(h.id, EVENT_CHECK_COMPLETED, c.id), webhookId: h.id, event: EVENT_CHECK_COMPLETED, checkId: c.id }));
  await prisma.webhookDelivery.createMany({ data: rows, skipDuplicates: true });
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
