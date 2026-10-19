/**
 * Check lifecycle on the API side: find the same target, dedupe/cache, spend a credit,
 * create Target + Check, enqueue the BullMQ job. Loading a full report lives here too
 * because the report route and the SSE "done" event return the same thing.
 */
import {
  PRIORITY,
  QUEUES,
  detect,
  progressKey,
  short,
  statusFromDb,
  targetKey,
  type CheckReportDTO,
  type CreateCheckResponse,
  type Detected,
} from '@apecheck/core';
import type { Prisma } from '@apecheck/db';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from './context';
import { consumeCredit, getCredits, refundCredit, type CreditSubject } from './credits';
import { ApiError, MSG, maxRequiredMessage } from './errors';
import { randomShortId } from './ids';
import { withLock } from './lock';
import { loadSeries, reportInclude, toReport, type Viewer } from './mappers';

type Target = Exclude<Detected, { kind: 'bad' }>;

/* ---------------- "same target" ---------------- */

/**
 * Target rows that are the same project as the input. Coins match on the address across
 * every chain key (incl. the preliminary "ca:evm:" one), sites on the domain, posts on the
 * tweet id, X profiles on the handle key.
 */
export function sameTargetWhere(d: Target): Prisma.TargetWhereInput {
  switch (d.kind) {
    case 'evm':
      return { kind: 'COIN', ca: { equals: d.address, mode: 'insensitive' } };
    case 'sol':
    case 'tron':
      return { kind: 'COIN', ca: d.address };
    case 'site':
      return { kind: 'SITE', domain: d.domain };
    case 'xpost':
      return { key: targetKey(d) };
  }
}

export function sameCheckWhere(d: Target): Prisma.CheckWhereInput {
  if (d.kind === 'xpost' && d.postId) return { OR: [{ postId: d.postId }, { target: { key: targetKey(d) } }] };
  return { target: sameTargetWhere(d) };
}

/** Preliminary Target fields until the worker resolves the project. */
export function targetSeed(d: Target): Pick<Prisma.TargetCreateInput, 'kind' | 'chain' | 'ca' | 'domain' | 'handle' | 'name' | 'key'> {
  const key = targetKey(d);
  switch (d.kind) {
    case 'evm':
      return { key, kind: 'COIN', chain: null, ca: d.address, domain: null, handle: null, name: short(d.address) };
    case 'sol':
      return { key, kind: 'COIN', chain: 'SOL', ca: d.address, domain: null, handle: null, name: short(d.address) };
    case 'tron':
      return { key, kind: 'COIN', chain: 'TRX', ca: d.address, domain: null, handle: null, name: short(d.address) };
    case 'site':
      return { key, kind: 'SITE', chain: null, ca: null, domain: d.domain, handle: null, name: d.domain };
    case 'xpost':
      return { key, kind: 'POST', chain: null, ca: null, domain: null, handle: d.handle, name: d.handle ? `@${d.handle}` : 'X post' };
  }
}

/**
 * Queued/running checks that can still finish. A run older than twice the check budget (or a
 * job queued for hours) is treated as dead: it must not block new checks or sit on /v1/live forever.
 */
export const QUEUED_STALE_MS = 2 * 3600_000;
export function activeCheckWhere(env: AppDeps['env'], now = Date.now()): Prisma.CheckWhereInput {
  const runCut = new Date(now - (env.CHECK_BUDGET_SECONDS * 2 + 60) * 1000);
  return {
    OR: [
      { status: 'RUNNING', OR: [{ startedAt: { gte: runCut } }, { startedAt: null, createdAt: { gte: runCut } }] },
      { status: 'QUEUED', createdAt: { gte: new Date(now - QUEUED_STALE_MS) } },
    ],
  };
}

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

const JOB_RETENTION = {
  removeOnComplete: { count: 2000, age: 24 * 3600 },
  removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
  // the worker throws only when the database fails while it claims the check (runCheck catches everything
  // after that), so a retry never re-runs stages; the last failure marks the check FAILED (worker.ts)
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

export async function createCheck(deps: AppDeps, input: CreateInput, subject: CreditSubject, log?: FastifyBaseLogger): Promise<CreateResult> {
  const { env, prisma, redis, queue } = deps;
  const d = detect(input.target);
  if (!d || d.kind === 'bad') throw new ApiError(400, 'bad_target', MSG.badTarget);
  // private checks are a Max feature (M3); never silently publish what was asked to be private
  if (input.private) throw new ApiError(403, 'max_required', maxRequiredMessage(env));

  return withLock(redis, `lock:create:${targetKey(d)}`, async () => {
    const same = sameCheckWhere(d);

    // a run in progress is as fresh as it gets, even for Re-check
    const active = await prisma.check.findFirst({
      where: { AND: [same, activeCheckWhere(env), { isPrivate: false }] },
      orderBy: { createdAt: 'desc' },
      select: { shortId: true, status: true },
    });
    if (active) {
      const c = await getCredits(redis, env, subject);
      return { statusCode: 200, body: { id: active.shortId, status: statusFromDb(active.status), cached: false, credits: c.credits } };
    }

    if (!input.recheck) {
      const fresh = await prisma.check.findFirst({
        where: {
          AND: [same, { status: 'DONE', isPrivate: false, finishedAt: { gte: new Date(Date.now() - env.CACHE_HOURS * 3600_000) } }],
        },
        orderBy: { finishedAt: 'desc' },
        select: { shortId: true },
      });
      if (fresh) {
        const c = await getCredits(redis, env, subject);
        return { statusCode: 200, body: { id: fresh.shortId, status: 'done', cached: true, credits: c.credits } };
      }
    }

    const spent = await consumeCredit(redis, env, subject);
    if (!spent.ok) throw new ApiError(402, 'no_credits', MSG.noCredits);

    let check: { id: string; shortId: string; targetId: string };
    try {
      check = await insertCheck(deps, d, input.target, subject);
    } catch (err) {
      await refundCredit(redis, subject).catch(() => undefined);
      throw err;
    }

    try {
      await queue.add('check', { checkId: check.id }, { jobId: check.id, priority: PRIORITY[subject.tier ?? 'free'], ...JOB_RETENTION });
    } catch (err) {
      log?.error({ err, checkId: check.id }, `could not enqueue on ${QUEUES.checks}`);
      await prisma
        .$transaction([
          prisma.check.update({ where: { id: check.id }, data: { status: 'FAILED', error: 'Could not queue the check', finishedAt: new Date() } }),
          prisma.target.update({ where: { id: check.targetId }, data: { checkCount: { decrement: 1 } } }),
        ])
        .catch(() => undefined);
      await refundCredit(redis, subject).catch(() => undefined);
      throw new ApiError(503, 'queue_unavailable', MSG.queueDown);
    }

    return { statusCode: 201, body: { id: check.shortId, status: 'queued', cached: false, credits: spent.credits } };
  });
}

async function uniqueShortId(deps: AppDeps): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const id = randomShortId();
    const hit = await deps.prisma.check.findUnique({ where: { shortId: id }, select: { id: true } });
    if (!hit) return id;
  }
  throw new Error('could not allocate a unique shortId');
}

async function insertCheck(deps: AppDeps, d: Target, raw: string, subject: CreditSubject) {
  const shortId = await uniqueShortId(deps);
  const seed = targetSeed(d);
  return deps.prisma.$transaction(async tx => {
    // reuse the project's row when one exists, e.g. an EVM coin the worker already re-keyed to its chain
    const existing = await tx.target.findFirst({
      where: sameTargetWhere(d),
      orderBy: [{ chain: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: { id: true },
    });
    const target = existing
      ? await tx.target.update({ where: { id: existing.id }, data: { checkCount: { increment: 1 } }, select: { id: true } })
      : await tx.target.upsert({
          where: { key: seed.key },
          create: { ...seed, checkCount: 1 },
          update: { checkCount: { increment: 1 } },
          select: { id: true },
        });
    return tx.check.create({
      data: {
        shortId,
        targetId: target.id,
        targetRaw: raw.trim().slice(0, 2048),
        postId: d.kind === 'xpost' ? d.postId : null,
        status: 'QUEUED',
        via: 'WEB',
        requesterId: subject.userId ?? null,
        requesterSid: subject.sid,
        isPrivate: false,
      },
      select: { id: true, shortId: true, targetId: true },
    });
  });
}

/* ---------------- read ---------------- */

export function canView(check: { isPrivate: boolean; requesterSid: string | null }, viewer: Viewer): boolean {
  return !check.isPrivate || (!!viewer.sid && check.requesterSid === viewer.sid);
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

/** Full report by internal id or shortId; null when missing or private to someone else. */
export async function loadReport(deps: AppDeps, where: { id: string } | { shortId: string }, viewer: Viewer): Promise<CheckReportDTO | null> {
  const row = await deps.prisma.check.findUnique({ where, include: reportInclude });
  if (!row || !canView(row, viewer)) return null;
  const running = row.status === 'RUNNING' || row.status === 'QUEUED';
  const [series, progress] = await Promise.all([loadSeries(deps.prisma, [row]), running ? readProgress(deps, [row.id]) : undefined]);
  return toReport(row, { env: deps.env, viewer, series, progress });
}
