/**
 * Check lifecycle on the API side: dedupe/cache and Target + Check creation come from @apecheck/db (shared with the
 * X bot); this file spends the credit and enqueues the BullMQ job. Loading a full report lives here too because
 * the report route and the SSE "done" event return the same thing.
 */
import {
  CHECK_JOB_OPTIONS,
  CHECK_JOINED_INDEX,
  CHECK_JOINERS_TTL_S,
  PRIORITY,
  QUEUES,
  chainFromDb,
  checkJoinersKey,
  detect,
  progressKey,
  statusFromDb,
  type CheckReportDTO,
  type CreateCheckResponse,
} from '@apecheck/core';
import { coinsByDeployer, createCheck as createCheckRow, createLockKey, failUnqueuedCheck, findReusableCheck, withCreateLock } from '@apecheck/db';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from './context';
import { consumeCredit, getCredits, refundCredit, type CreditSubject } from './credits';
import { ApiError, MSG, maxRequiredMessage } from './errors';
import { loadSeries, reportInclude, toReport, type Viewer } from './mappers';

/** coins of the deployer's history a report carries (CoinFactsDTO.deployerHistory.coins; `total` counts them all) */
export const DEPLOYER_HISTORY_COINS = 10;

/* ---------------- "same target", running, cached (shared with the X bot: @apecheck/db checks.ts) ---------------- */

export { QUEUED_STALE_MS, activeCheckWhere, sameCheckWhere, sameTargetWhere, targetSeed } from '@apecheck/db';

/* ---------------- create ---------------- */

export interface CreateInput {
  target: string;
  recheck?: boolean;
  private?: boolean;
  /** M4: who started it: the site (default) or a developer's API key (REST or MCP) */
  via?: 'WEB' | 'API';
}

export interface CreateResult {
  /** 201 for a new check, 200 when an existing one was returned */
  statusCode: 200 | 201;
  body: CreateCheckResponse;
}

/**
 * M4: a Max user whose request joined a check that was already running asked for it as much as its requester did:
 * the worker sends them its check.completed webhooks too (webhooks/events.ts reads checkJoinersKey; the sweep catches
 * up through CHECK_JOINED_INDEX). Internal Check.id. Best effort: a Redis error is logged and never fails the request.
 */
async function recordJoiner(deps: Pick<AppDeps, 'redis'>, checkId: string, userId: string, log?: FastifyBaseLogger) {
  const key = checkJoinersKey(checkId);
  const now = Date.now();
  await deps.redis
    .multi()
    .sadd(key, userId)
    .expire(key, CHECK_JOINERS_TTL_S)
    .zadd(CHECK_JOINED_INDEX, now, checkId)
    .zremrangebyscore(CHECK_JOINED_INDEX, '-inf', now - CHECK_JOINERS_TTL_S * 1000)
    .exec()
    .catch(err => log?.warn({ err, checkId }, 'could not record who joined the check'));
}

/**
 * Same target already running → that check; a public verdict younger than CACHE_HOURS (unless Re-check) → that
 * one (both free); else spend a credit, create Target + Check (shared with the bot) and enqueue the job. A Max user
 * who joins a running check gets its check.completed webhooks too (recordJoiner); a cached verdict sends none.
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
      if (reuse.reason === 'running' && subject.userId && subject.tier === 'max') await recordJoiner(deps, reuse.id, subject.userId, log);
      const c = await getCredits(redis, env, subject);
      return reuse.reason === 'running'
        ? { statusCode: 200, body: { id: reuse.shortId, status: statusFromDb(reuse.status), cached: false, credits: c.credits } }
        : { statusCode: 200, body: { id: reuse.shortId, status: 'done', cached: true, credits: c.credits } };
    }

    const spent = await consumeCredit(redis, env, subject);
    if (!spent.ok) throw new ApiError(402, 'no_credits', MSG.noCredits);

    let check: { id: string; shortId: string; targetId: string; isPrivate: boolean };
    try {
      check = await createCheckRow(prisma, d, { raw: input.target, via: input.via ?? 'WEB', requesterId: subject.userId ?? null, requesterSid: subject.sid, isPrivate });
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
  const chain = chainFromDb(row.target.chain);
  const wallet = row.coinFacts?.deployerAddress ?? null;
  const [series, progress, watch, votes, deployerHistory] = await Promise.all([
    loadSeries(deps.prisma, [row]),
    running ? readProgress(deps, [row.id]) : undefined,
    userId ? deps.prisma.watch.findUnique({ where: { userId_targetId: { userId, targetId: row.targetId } }, select: { userId: true } }) : null,
    userId && row.notes.length
      ? deps.prisma.noteVote.findMany({ where: { userId, noteId: { in: row.notes.map(n => n.id) } }, select: { noteId: true } })
      : [],
    // the deployer history: the other coins from the wallet that ApeCheck has checked (public checks); a failed lookup
    // shows "not checked", never a broken report
    wallet && chain
      ? coinsByDeployer(deps.prisma, { chain, address: wallet, excludeCa: row.target.ca, take: DEPLOYER_HISTORY_COINS }).catch(() => null)
      : null,
  ]);
  const report = toReport(row, { env: deps.env, viewer, series, progress, votes: new Set(votes.map(v => v.noteId)), deployerHistory });
  return userId ? { ...report, watching: !!watch } : report;
}
