/**
 * Check lifecycle on the API side: dedupe/cache and Target + Check creation come from @apecheck/db (shared with the
 * X bot); this file spends the credit and enqueues the BullMQ job. Loading a full report lives here too because
 * the report route and the SSE "done" event return the same thing.
 */
import {
  CHECK_JOB_OPTIONS,
  PRIORITY,
  QUEUES,
  detect,
  progressKey,
  statusFromDb,
  type CheckReportDTO,
  type CreateCheckResponse,
} from '@apecheck/core';
import { createCheck as createCheckRow, createLockKey, failUnqueuedCheck, findReusableCheck, withCreateLock } from '@apecheck/db';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from './context';
import { consumeCredit, getCredits, refundCredit, type CreditSubject } from './credits';
import { ApiError, MSG, maxRequiredMessage } from './errors';
import { loadSeries, reportInclude, toReport, type Viewer } from './mappers';

/* ---------------- "same target", running, cached (shared with the X bot: @apecheck/db checks.ts) ---------------- */

export { QUEUED_STALE_MS, activeCheckWhere, sameCheckWhere, sameTargetWhere, targetSeed } from '@apecheck/db';

/* ---------------- create ---------------- */

export interface CreateInput {
  target: string;
  recheck?: boolean;
  private?: boolean;
}

export interface CreateResult {
  /** 201 for a new check, 200 when an existing one was returned */
  statusCode: 200 | 201;
  body: CreateCheckResponse;
}

/**
 * Same target already running → that check; a public verdict younger than CACHE_HOURS (unless Re-check) → that
 * one (both free); else spend a credit, create Target + Check (shared with the bot) and enqueue the job.
 */
export async function createCheck(deps: AppDeps, input: CreateInput, subject: CreditSubject, log?: FastifyBaseLogger): Promise<CreateResult> {
  const { env, prisma, redis, queue } = deps;
  const d = detect(input.target);
  if (!d || d.kind === 'bad') throw new ApiError(400, 'bad_target', MSG.badTarget);
  // private checks are a Max feature (M3); never silently publish what was asked to be private
  const isPrivate = !!input.private;
  if (isPrivate && !(subject.userId && subject.tier === 'max')) throw new ApiError(403, 'max_required', maxRequiredMessage(env));

  return withCreateLock(redis, createLockKey(d), async () => {
    // a run in progress is as fresh as it gets, even for Re-check; a private request also reuses its own private runs
    const reuse = await findReusableCheck(prisma, d, {
      cacheHours: env.CACHE_HOURS,
      checkBudgetSeconds: env.CHECK_BUDGET_SECONDS,
      recheck: input.recheck,
      privateFor: isPrivate ? subject.userId : null,
    });
    if (reuse) {
      const c = await getCredits(redis, env, subject);
      return reuse.reason === 'running'
        ? { statusCode: 200, body: { id: reuse.shortId, status: statusFromDb(reuse.status), cached: false, credits: c.credits } }
        : { statusCode: 200, body: { id: reuse.shortId, status: 'done', cached: true, credits: c.credits } };
    }

    const spent = await consumeCredit(redis, env, subject);
    if (!spent.ok) throw new ApiError(402, 'no_credits', MSG.noCredits);

    let check: { id: string; shortId: string; targetId: string; isPrivate: boolean };
    try {
      check = await createCheckRow(prisma, d, { raw: input.target, via: 'WEB', requesterId: subject.userId ?? null, requesterSid: subject.sid, isPrivate });
    } catch (err) {
      await refundCredit(redis, subject).catch(() => undefined);
      throw err;
    }

    try {
      await queue.add('check', { checkId: check.id }, { jobId: check.id, priority: PRIORITY[subject.tier ?? 'free'], ...CHECK_JOB_OPTIONS });
    } catch (err) {
      log?.error({ err, checkId: check.id }, `could not enqueue on ${QUEUES.checks}`);
      await failUnqueuedCheck(prisma, check).catch(() => undefined);
      await refundCredit(redis, subject).catch(() => undefined);
      throw new ApiError(503, 'queue_unavailable', MSG.queueDown);
    }

    return { statusCode: 201, body: { id: check.shortId, status: 'queued', cached: false, credits: spent.credits } };
  });
}

/* ---------------- read ---------------- */

/**
 * Private checks (Max) are visible only to the user who asked for them, on any device they are signed in on. Signing
 * out ends a browser's access (a shared computer must not keep showing them to whoever uses it next). A private check
 * with no requesting user (none can be created that way) is visible to the browser (cookie) that started it.
 */
export function canView(check: { isPrivate: boolean; requesterSid: string | null; requesterId: string | null }, viewer: Viewer): boolean {
  if (!check.isPrivate) return true;
  if (check.requesterId) return !!viewer.userId && check.requesterId === viewer.userId;
  return !!viewer.sid && check.requesterSid === viewer.sid;
}

export async function readProgress(deps: AppDeps, checkIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (!checkIds.length) return out;
  const vals = await deps.redis.mget(...checkIds.map(progressKey)).catch(() => checkIds.map(() => null));
  checkIds.forEach((id, i) => {
    const n = vals[i] == null ? NaN : Number.parseFloat(vals[i]!);
    out.set(id, Number.isFinite(n) ? n : null);
  });
  return out;
}

/**
 * Full report by internal id or shortId; null when missing or private to someone else. For a signed-in viewer it
 * also says whether they watch the target and which notes they marked helpful.
 */
export async function loadReport(deps: AppDeps, where: { id: string } | { shortId: string }, viewer: Viewer): Promise<CheckReportDTO | null> {
  const row = await deps.prisma.check.findUnique({ where, include: reportInclude });
  if (!row || !canView(row, viewer)) return null;
  const running = row.status === 'RUNNING' || row.status === 'QUEUED';
  const userId = viewer.userId;
  const [series, progress, watch, votes] = await Promise.all([
    loadSeries(deps.prisma, [row]),
    running ? readProgress(deps, [row.id]) : undefined,
    userId ? deps.prisma.watch.findUnique({ where: { userId_targetId: { userId, targetId: row.targetId } }, select: { userId: true } }) : null,
    userId && row.notes.length
      ? deps.prisma.noteVote.findMany({ where: { userId, noteId: { in: row.notes.map(n => n.id) } }, select: { noteId: true } })
      : [],
  ]);
  const report = toReport(row, { env: deps.env, viewer, series, progress, votes: new Set(votes.map(v => v.noteId)) });
  return userId ? { ...report, watching: !!watch } : report;
}
