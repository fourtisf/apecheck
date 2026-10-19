/**
 * Watchlist and re-check alerts (M3), signed-in users only (401 sign_in_required).
 *
 *   POST   /v1/watch/:targetId          → WatchResponse { watching: true }   (idempotent)
 *   DELETE /v1/watch/:targetId          → { watching: false }                (idempotent)
 *   GET    /v1/watchlist                → WatchlistResponse: the latest finished check of every watched target that
 *                                         the viewer may see (public, or their own private one), newest first, plus
 *                                         every watched target id
 *   GET    /v1/notifications?limit=     → NotificationsResponse (newest first, default 30, max 100)
 *   POST   /v1/notifications/read {ids?} → { unread }  (no ids: everything)
 *
 * The worker's change detector (rechecks queue) writes Notification rows and Watch.lastAlertAt / lastRecheckAt.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { NotificationDTO, NotificationsResponse, WatchResponse, WatchlistResponse } from '@apecheck/core';
import { Prisma, type PrismaClient, type User } from '@apecheck/db';
import { unreadCount } from '../accounts';
import type { AppDeps } from '../context';
import { ApiError, MSG } from '../errors';
import { userBurst } from '../limits';
import { loadSeries, summaryInclude, toSummary, type CheckSummaryRow } from '../mappers';
import { opt, viewerOf } from './util';

/** per-IP route limits (per minute) */
export const WATCH_RATE = { watch: 60, watchlist: 60, notifications: 60, notificationsRead: 30 } as const;
const rate = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

/** most targets one user may watch */
export const WATCH_MAX = 200;
const RE_CUID = /^[a-z0-9]{20,32}$/i;

const TargetParamsZ = z.object({ targetId: z.string().max(64) });
const NotificationsQueryZ = z.object({ limit: opt(z.coerce.number().int().min(1).max(100).default(30)) });
const ReadBodyZ = z.object({ ids: z.array(z.string().max(64)).max(200).optional() }).nullish();

function signedIn(request: FastifyRequest, message: string = MSG.signInRequired): User {
  const user = request.viewer.user;
  if (!user) throw new ApiError(401, 'sign_in_required', message);
  return user;
}

/** checks of a target the user may see: public ones and their own private ones */
const visibleTo = (userId: string): Prisma.CheckWhereInput => ({ OR: [{ isPrivate: false }, { isPrivate: true, requesterId: userId }] });

/**
 * The latest finished check of each target that the user may see (public, or their own private one), picked in SQL
 * with DISTINCT ON over the (targetId, finishedAt) index. Prisma's `distinct` option would not: without the
 * nativeDistinct preview it fetches every finished check of every target and de-duplicates in memory, and popular
 * targets gather thousands of checks (bot traffic, re-checks, automatic watch re-checks).
 */
export async function latestVisibleChecks(
  prisma: PrismaClient,
  targetIds: readonly string[],
  userId: string,
): Promise<{ id: string; targetId: string; shortId: string }[]> {
  if (!targetIds.length) return [];
  return prisma.$queryRaw<{ id: string; targetId: string; shortId: string }[]>`
    SELECT DISTINCT ON ("targetId") "id", "targetId", "shortId"
    FROM "Check"
    WHERE "targetId" IN (${Prisma.join([...targetIds])})
      AND "status" = 'DONE'
      AND ("isPrivate" = false OR "requesterId" = ${userId})
    ORDER BY "targetId", "finishedAt" DESC NULLS LAST, "id" DESC`;
}

/** the worker's job id for a target's fingerprint job (apps/worker watch/index.ts recheckJobId): one per target at a time */
export const recheckJobId = (targetId: string) => `fp-${targetId}`;

/**
 * A Pro/Max user starts watching a target that has never been fingerprinted: queue its first fingerprint now (worker-
 * prices, queue "rechecks") instead of waiting up to 15 minutes for the next scan, so a change made soon after is
 * caught. Best effort: the scan picks the target up anyway.
 */
async function queueFirstFingerprint(deps: AppDeps, targetId: string) {
  if (!deps.rechecks) return;
  try {
    const t = await deps.prisma.target.findUnique({ where: { id: targetId }, select: { fingerprintAt: true } });
    if (!t || t.fingerprintAt) return;
    await deps.rechecks.add('target', { targetId }, { jobId: recheckJobId(targetId), removeOnComplete: true, removeOnFail: 200 });
  } catch {
    /* the 15-minute scan takes it */
  }
}

export function registerWatchRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, redis } = deps;

  app.post('/v1/watch/:targetId', rate(WATCH_RATE.watch), async (request): Promise<WatchResponse> => {
    const user = signedIn(request);
    const { targetId } = TargetParamsZ.parse(request.params);
    // watching a target already on the list changes nothing and costs no burst (a browser list moving to the account
    // after sign-in may send the same targets again on a later visit)
    if (RE_CUID.test(targetId)) {
      const existing = await prisma.watch.findUnique({ where: { userId_targetId: { userId: user.id, targetId } }, select: { userId: true } });
      if (existing) return { watching: true };
    }
    await userBurst(redis, 'watch', user.id);
    // a target is only watchable through a check the viewer can see (another user's private check doesn't reveal it)
    const seen = RE_CUID.test(targetId) ? await prisma.check.findFirst({ where: { AND: [{ targetId }, visibleTo(user.id)] }, select: { id: true } }) : null;
    if (!seen) throw new ApiError(404, 'not_found', MSG.targetNotFound);
    if ((await prisma.watch.count({ where: { userId: user.id } })) >= WATCH_MAX) throw new ApiError(409, 'watchlist_full', MSG.watchlistFull);
    await prisma.watch.upsert({ where: { userId_targetId: { userId: user.id, targetId } }, create: { userId: user.id, targetId }, update: {} });
    if (user.tier === 'PRO' || user.tier === 'MAX') await queueFirstFingerprint(deps, targetId);
    return { watching: true };
  });

  app.delete('/v1/watch/:targetId', rate(WATCH_RATE.watch), async (request): Promise<WatchResponse> => {
    const user = signedIn(request);
    const { targetId } = TargetParamsZ.parse(request.params);
    await userBurst(redis, 'watch', user.id);
    if (RE_CUID.test(targetId)) await prisma.watch.deleteMany({ where: { userId: user.id, targetId } });
    return { watching: false };
  });

  app.get('/v1/watchlist', rate(WATCH_RATE.watchlist), async (request): Promise<WatchlistResponse> => {
    const user = signedIn(request);
    await userBurst(redis, 'watchlist', user.id);
    const watches = await prisma.watch.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, select: { targetId: true } });
    const targetIds = watches.map(w => w.targetId);
    if (!targetIds.length) return { items: [], targetIds };
    // one row per target, chosen in SQL; then only those rows are loaded, newest first
    const ids = (await latestVisibleChecks(prisma, targetIds, user.id)).map(r => r.id);
    const latest: CheckSummaryRow[] = ids.length
      ? await prisma.check.findMany({ where: { id: { in: ids } }, include: summaryInclude, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }] })
      : [];
    const series = await loadSeries(prisma, latest);
    const ctx = { env: deps.env, viewer: viewerOf(request), series };
    return { items: latest.map(r => toSummary(r, ctx)), targetIds };
  });

  app.get('/v1/notifications', rate(WATCH_RATE.notifications), async (request): Promise<NotificationsResponse> => {
    const user = signedIn(request, MSG.signInForAlerts);
    const q = NotificationsQueryZ.parse(request.query ?? {});
    await userBurst(redis, 'notifications', user.id);
    const [rows, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit }),
      unreadCount(deps, user.id),
    ]);

    // the check to open: the re-check the alert points to (if the viewer can see it), else the target's latest one
    const checkIds = [...new Set(rows.map(r => r.checkId).filter((x): x is string => !!x))];
    const targetIds = [...new Set(rows.map(r => r.targetId))];
    const [pointed, latest] = await Promise.all([
      checkIds.length
        ? prisma.check.findMany({ where: { AND: [{ id: { in: checkIds } }, visibleTo(user.id)] }, select: { id: true, shortId: true } })
        : [],
      latestVisibleChecks(prisma, targetIds, user.id),
    ]);
    const shortOf = new Map(pointed.map(c => [c.id, c.shortId]));
    const latestOf = new Map(latest.map(c => [c.targetId, c.shortId]));
    const items: NotificationDTO[] = rows.map(n => ({
      id: n.id,
      kind: n.kind,
      text: n.text,
      targetId: n.targetId,
      checkId: (n.checkId ? shortOf.get(n.checkId) : undefined) ?? latestOf.get(n.targetId) ?? null,
      createdAt: n.createdAt.toISOString(),
      read: n.readAt != null,
    }));
    return { items, unread };
  });

  app.post('/v1/notifications/read', rate(WATCH_RATE.notificationsRead), async (request): Promise<{ unread: number }> => {
    const user = signedIn(request, MSG.signInForAlerts);
    const body = ReadBodyZ.parse(request.body ?? null);
    await userBurst(redis, 'notificationsRead', user.id);
    const ids = body?.ids?.filter(id => RE_CUID.test(id));
    if (!body?.ids || ids?.length) {
      await prisma.notification.updateMany({
        where: { userId: user.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
        data: { readAt: new Date() },
      });
    }
    return { unread: await unreadCount(deps, user.id) };
  });
}
