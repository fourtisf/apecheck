/**
 * Re-check alerts (HANDOFF §8): the Notification rows watchers read on the site (GET /v1/notifications).
 *
 *  kind "changed"   — a watched target's site / contract / mint / X profile changed (recheck.ts). For a Max watcher
 *                     whose automatic re-check started, `checkId` is that re-check (internal Check.id) and the text
 *                     says so; otherwise `checkId` is null (the site opens the target's latest check).
 *  kind "rechecked" — that automatic re-check finished (or couldn't): the new verdict next to the old one.
 *
 * The marker that links an automatic re-check to its watchers is the "changed" Notification itself: it is written
 * with `checkId` = the re-check before the check's job is queued. When a check finishes (Stage F, a failure, the
 * stuck-check recovery, a job re-run on a finished check), completeAutoRechecks() looks for "changed" notifications
 * of that check among the target's watchers and gives each of those users one "rechecked" notification (once per
 * user and check: a Postgres advisory lock per check plus an existence check make it idempotent). Durable (no Redis
 * state to lose) and cheap: two indexed reads when the target has no watchers, which is most checks.
 */
import { NAR_BANDS, detect, isNotEnough, targetKey, type Detected } from '@apecheck/core';
import type { Prisma, PrismaClient } from '@apecheck/db';
import type { Logger } from '../log';
import { pgText } from '../pipeline/pgsafe';
import type { FingerprintKind } from './fingerprint';

export const NOTIFY_CHANGED = 'changed';
export const NOTIFY_RECHECKED = 'rechecked';

const bandName = (key: string | null | undefined, score: number | null | undefined): string | null => {
  if (score == null || !Number.isFinite(score)) return null;
  const s = Math.round(score);
  const band = NAR_BANDS.find(b => b.key === key) ?? NAR_BANDS.find(b => s >= b.min) ?? NAR_BANDS[NAR_BANDS.length - 1];
  return `${band.name} ${s}`;
};

/** "orbitswap.xyz changed since its last check" (plain, one clause; "; re-checking it now" when a re-check started). */
export function changedText(name: string, kind: FingerprintKind, rechecking: boolean): string {
  const what =
    kind === 'site' ? `${name} changed since its last check`
    : kind === 'contract' ? `${name}'s contract changed since its last check`
    : kind === 'mint' ? `${name}'s mint or freeze authority changed since its last check`
    : `${name} changed its X profile since its last check`;
  return pgText(rechecking ? `${what}; re-checking it now` : what).slice(0, 300);
}

/** "Re-checked orbitswap.xyz: Likely real 72, was Partly real 48" — or why there is no new verdict. */
export function recheckedText(
  name: string,
  check: { status: string; narScore: number | null; narBand: string | null; error?: string | null },
  prev: { narScore: number | null; narBand: string | null } | null,
): string {
  const now = check.status === 'DONE' ? bandName(check.narBand, check.narScore) : null;
  if (!now && isNotEnough(check.error)) return pgText(`The re-check of ${name} found nothing to test; the last verdict stands`).slice(0, 300);
  if (!now) return pgText(`The re-check of ${name} couldn't finish; the last verdict stands`).slice(0, 300);
  const was = prev ? bandName(prev.narBand, prev.narScore) : null;
  return pgText(was ? `Re-checked ${name}: ${now}, was ${was}` : `Re-checked ${name}: ${now}`).slice(0, 300);
}

/**
 * Target rows of the same project as a check's input, by indexed equality (the "same target" rule of @apecheck/db
 * sameTargetWhere, without its case-insensitive EVM match, which can't use the index: EVM addresses are stored
 * lowercase everywhere, detect() and the pipeline lowercase them).
 */
function projectTargetsWhere(d: Exclude<Detected, { kind: 'bad' }>): Prisma.TargetWhereInput {
  switch (d.kind) {
    case 'evm':
      return { kind: 'COIN', ca: d.address.toLowerCase() };
    case 'sol':
    case 'tron':
      return { kind: 'COIN', ca: d.address };
    case 'site':
      return { kind: 'SITE', domain: d.domain };
    case 'xpost':
      return { key: targetKey(d) };
  }
}

/**
 * A check finished: every watcher whose "changed" alert pointed at it (an automatic re-check, recheck.ts) gets one
 * "rechecked" notification with the new verdict ("was" = the verdict that stood when the re-check was created).
 * Returns how many were written. Safe to call for any check, any number of times.
 */
export async function completeAutoRechecks(deps: { prisma: PrismaClient; log: Logger }, checkId: string): Promise<number> {
  const { prisma } = deps;
  const c = await prisma.check.findUnique({
    where: { id: checkId },
    select: { id: true, status: true, error: true, targetId: true, targetRaw: true, narScore: true, narBand: true, createdAt: true, target: { select: { name: true } } },
  });
  if (!c || (c.status !== 'DONE' && c.status !== 'FAILED')) return 0;
  // the watched Target row, and any other row of the same project the run may have moved the check to (re-keying)
  const targetIds = new Set([c.targetId]);
  const d = detect(c.targetRaw);
  if (d && d.kind !== 'bad') {
    for (const t of await prisma.target.findMany({ where: projectTargetsWhere(d), select: { id: true }, take: 20 })) targetIds.add(t.id);
  }
  const watchers = await prisma.watch.findMany({ where: { targetId: { in: [...targetIds] } }, select: { userId: true } });
  if (!watchers.length) return 0;
  const userIds = [...new Set(watchers.map(w => w.userId))];

  const written = await prisma.$transaction(async tx => {
    // one completer per check at a time (Stage F and a late recheck.ts can both get here)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recheck:${c.id}`}))`;
    const started = await tx.notification.findMany({
      where: { userId: { in: userIds }, checkId: c.id, kind: NOTIFY_CHANGED },
      orderBy: { createdAt: 'asc' },
      select: { userId: true, targetId: true },
    });
    if (!started.length) return 0;
    const done = new Set(
      (await tx.notification.findMany({ where: { userId: { in: started.map(s => s.userId) }, checkId: c.id, kind: NOTIFY_RECHECKED }, select: { userId: true } })).map(n => n.userId),
    );
    const todo = new Map<string, string>();
    for (const s of started) if (!done.has(s.userId) && !todo.has(s.userId)) todo.set(s.userId, s.targetId);
    if (!todo.size) return 0;
    const prev =
      c.status === 'DONE'
        ? await tx.check.findFirst({
            where: { targetId: { in: [...targetIds] }, id: { not: c.id }, status: 'DONE', isPrivate: false, finishedAt: { lt: c.createdAt } },
            orderBy: { finishedAt: 'desc' },
            select: { narScore: true, narBand: true },
          })
        : null;
    const text = recheckedText(c.target.name, c, prev);
    await tx.notification.createMany({
      data: [...todo].map(([userId, targetId]) => ({ userId, targetId, checkId: c.id, kind: NOTIFY_RECHECKED, text })),
    });
    return todo.size;
  });
  if (written) deps.log.info(`check ${c.id}: ${written} watcher(s) told about the automatic re-check`);
  return written;
}
