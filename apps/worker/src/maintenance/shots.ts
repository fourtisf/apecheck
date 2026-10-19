/**
 * Screenshot retention (HANDOFF §12.6, DEPLOY.md §9). Once a day worker-prices deletes, for every check that
 * finished more than TUNING.shotsKeepDays ago, its screenshot folder SCREENSHOT_DIR/<checkId>/ and its saved share
 * card SCREENSHOT_DIR/cards/<shortId>.png — except checks on the feed's top lists (the top TUNING.shotsKeepTop of
 * Most checked, Most real and Least real among the latest public verdicts), which keep theirs.
 *
 * The cleaned checks' CheckStep.screenshot and Check.cardPath are cleared too, so a report shows the camera's idle
 * state instead of broken images (the web still draws /card/<id>.png on demand from the stored report).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { TUNING } from '@apecheck/core';
import type { Prisma, PrismaClient } from '@apecheck/db';
import type { Logger } from '../log';

const DAY = 86_400_000;

/** Daily, at a quiet hour (UTC). */
export const SHOTS_CLEANUP_PATTERN = '20 3 * * *';
export const SHOTS_CLEANUP_JOB = 'shots-cleanup';

export interface ShotsCandidate {
  id: string;
  shortId: string;
  finishedAt: Date | null;
}

/** The feed's rows (apps/api routes/feed.ts FEED_BASE): one per target, its newest finished public check. */
const FEED_BASE: Prisma.CheckWhereInput = { isLatest: true, status: 'DONE', isPrivate: false };

/** Same orderings as the feed tabs Most checked / Most real / Least real (apps/api routes/feed.ts FEED_ORDER). */
export const TOP_LIST_ORDERS: Record<'checked' | 'real' | 'least', Prisma.CheckOrderByWithRelationInput[]> = {
  checked: [{ target: { checkCount: 'desc' } }, { finishedAt: 'desc' }, { id: 'desc' }],
  real: [{ totalScore: { sort: 'desc', nulls: 'last' } }, { finishedAt: 'desc' }, { id: 'desc' }],
  least: [{ totalScore: { sort: 'asc', nulls: 'last' } }, { finishedAt: 'desc' }, { id: 'desc' }],
};

/** Ids of the checks on the feed's top lists right now: their screenshots are kept. */
export async function topListCheckIds(prisma: PrismaClient, top: number = TUNING.shotsKeepTop): Promise<Set<string>> {
  const lists = await Promise.all(
    Object.values(TOP_LIST_ORDERS).map(orderBy => prisma.check.findMany({ where: FEED_BASE, orderBy, take: top, select: { id: true } })),
  );
  return new Set(lists.flat().map(c => c.id));
}

/**
 * The selection rule, on its own: checks that finished before now − keepDays and are not protected.
 * (A check that never finished has nothing to expire.)
 */
export function selectExpired<T extends ShotsCandidate>(candidates: T[], protectedIds: ReadonlySet<string>, now: number, keepDays: number = TUNING.shotsKeepDays): T[] {
  const cutoff = now - keepDays * DAY;
  return candidates.filter(c => c.finishedAt != null && c.finishedAt.getTime() < cutoff && !protectedIds.has(c.id));
}

/** Finished checks past the cutoff that still have something to clean (a step screenshot or a saved card). */
export async function findExpiredShots(
  prisma: PrismaClient,
  opts: { now?: number; keepDays?: number; top?: number; limit?: number; protectedIds?: ReadonlySet<string> } = {},
): Promise<ShotsCandidate[]> {
  const now = opts.now ?? Date.now();
  const keepDays = opts.keepDays ?? TUNING.shotsKeepDays;
  const protectedIds = opts.protectedIds ?? (await topListCheckIds(prisma, opts.top));
  const rows = await prisma.check.findMany({
    where: {
      status: { in: ['DONE', 'FAILED'] },
      finishedAt: { lt: new Date(now - keepDays * DAY) },
      id: { notIn: [...protectedIds] },
      OR: [{ cardPath: { not: null } }, { steps: { some: { screenshot: { not: null } } } }],
    },
    select: { id: true, shortId: true, finishedAt: true },
    orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }],
    take: opts.limit ?? 200,
  });
  return selectExpired(rows, protectedIds, now, keepDays);
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** `<dir>/<name>` only for a plain file/folder name, never a path that leaves `dir`. */
function inside(dir: string, ...names: string[]): string | null {
  if (!names.every(n => SAFE_SEGMENT.test(n.replace(/\.png$/, '')))) return null;
  const p = path.resolve(dir, ...names);
  return p.startsWith(path.resolve(dir) + path.sep) ? p : null;
}

export interface ShotsCleanupResult {
  checks: number;
  folders: number;
  cards: number;
}

/**
 * Delete expired screenshots and cards, then clear the DB references. Files go first: if the DB update fails,
 * the next run picks the same checks again (deleting is idempotent); the other order could orphan files forever.
 */
export async function cleanupShots(
  deps: { prisma: PrismaClient; screenshotDir: string; log: Logger },
  opts: { now?: number; keepDays?: number; top?: number; batch?: number; maxChecks?: number } = {},
): Promise<ShotsCleanupResult> {
  const { prisma, screenshotDir, log } = deps;
  const batch = opts.batch ?? 200;
  const maxChecks = opts.maxChecks ?? 20_000;
  const protectedIds = await topListCheckIds(prisma, opts.top);
  const out: ShotsCleanupResult = { checks: 0, folders: 0, cards: 0 };
  const seen = new Set<string>();

  while (out.checks < maxChecks) {
    const list = (await findExpiredShots(prisma, { ...opts, limit: batch, protectedIds })).filter(c => !seen.has(c.id));
    if (!list.length) break;
    for (const c of list) {
      seen.add(c.id);
      const folder = inside(screenshotDir, c.id);
      if (folder && (await exists(folder))) {
        await fs.rm(folder, { recursive: true, force: true });
        out.folders++;
      }
      const card = inside(screenshotDir, 'cards', `${c.shortId}.png`);
      if (card && (await exists(card))) {
        await fs.rm(card, { force: true });
        out.cards++;
      }
    }
    const ids = list.map(c => c.id);
    await prisma.$transaction([
      prisma.checkStep.updateMany({ where: { checkId: { in: ids }, screenshot: { not: null } }, data: { screenshot: null } }),
      prisma.check.updateMany({ where: { id: { in: ids }, cardPath: { not: null } }, data: { cardPath: null } }),
    ]);
    out.checks += list.length;
    if (list.length < batch) break;
  }
  if (out.checks) log.info(`screenshots: cleaned ${out.checks} check(s) older than ${opts.keepDays ?? TUNING.shotsKeepDays} days (${out.folders} folders, ${out.cards} cards); ${protectedIds.size} top-list checks kept`);
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
