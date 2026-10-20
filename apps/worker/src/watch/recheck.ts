/**
 * Re-check alerts (queue "rechecks", HANDOFF §8): Pro "re-check alerts when a site or contract changes", Max
 * "watchlists that re-check on their own".
 *
 *  scan (every SCAN_EVERY_MS)  → watched targets with at least one Pro/Max watcher whose fingerprint is older than
 *                                WATCH_RECHECK_HOURS (or missing), oldest first, one RecheckJob each;
 *  processRecheck(targetId)    → the fingerprint now (fingerprint.ts). The first one is only stored. A different one is
 *                                read a second time, a few seconds later, and only a confirmed change counts (a page
 *                                that differs on every load, or a flaky RPC, never alerts); a failed read never does
 *                                either (retried in an hour, or a day for a target that can't be read at all). A
 *                                confirmed change is news only to the watchers the stored fingerprint was kept for:
 *                                those who started watching before it was COVER_INTERVALS × WATCH_RECHECK_HOURS old
 *                                (a fingerprint nobody paid kept current — the last Pro/Max watcher left weeks ago —
 *                                is no baseline for someone who just started watching: with nobody covered it is
 *                                only replaced, "rebaselined"). For those watchers:
 *                                  - one "changed" Notification per Pro/Max watcher, Watch.lastAlertAt, and (M4) a
 *                                    watch.changed delivery for each enabled webhook of a Max watcher subscribed to it;
 *                                  - for Max watchers under MAX_AUTO_RECHECKS_PER_DAY (automatic re-checks they got
 *                                    today, UTC; the slot is reserved atomically per user and day in Redis, so
 *                                    targets changing at once can't overrun it) whose watch wasn't re-checked in the
 *                                    last AUTO_RECHECK_GAP_MS: one
 *                                    automatic re-check of the target (the shared createCheck via WEB, requesterId = the
 *                                    first of them, PRIORITY.recheck, never charged to anyone's daily credits; a run of
 *                                    the same target already in progress is joined instead), Watch.lastRecheckAt, and
 *                                    their "changed" notification points at it (notify.ts: that row is the marker the
 *                                    "rechecked" notification completes when the check finishes, and M4: the marker
 *                                    that sends the check.completed webhooks of every one of them, not only the
 *                                    requester's: webhooks/events.ts).
 * Only targets with a public verdict are re-checked automatically (a Max user's private check is never re-run in
 * public); their watchers still get the "changed" alert.
 */
import { CHECK_JOB_OPTIONS, PRIORITY, detect, nextUtcMidnight, utcDay, type Env } from '@apecheck/core';
import { createCheck, createLockKey, failUnqueuedCheck, findReusableCheck, withCreateLock, type CreatedCheck, type Prisma, type PrismaClient } from '@apecheck/db';
import type { Sources } from '@apecheck/sources';
import type { Redis } from 'ioredis';
import { errText, type Logger } from '../log';
import { fingerprintKind, fingerprintScheme, fingerprintTarget, type FingerprintKind, type WatchedTarget } from './fingerprint';
import { NOTIFY_CHANGED, changedText, completeAutoRechecks } from './notify';
import { checkCompletedDeliveries, readJoiners, watchChangedDeliveries } from '../webhooks/events';

export const SCAN_EVERY_MS = 15 * 60_000;
/** a watch is re-checked automatically at most this often */
export const AUTO_RECHECK_GAP_MS = 12 * 3600_000;
/** targets taken per scan (the rest are next in line: oldest fingerprint first) */
export const SCAN_MAX = 500;
/** a scan running a little late still picks a target that is due */
const DUE_SLACK_MS = 5 * 60_000;
/** after a failed read: try again in an hour; a target that can't be read at all (no RPC, X off): in a day */
export const RETRY_AFTER_S = 3600;
export const GIVE_UP_FOR_S = 24 * 3600;
export const retryKey = (targetId: string) => `watch:retry:${targetId}`;
/**
 * A stored fingerprint is the baseline of the watchers who started watching before it was this many
 * WATCH_RECHECK_HOURS old: one kept by its watchers is never older than one interval plus a late scan or a few
 * failed reads; one older than that was frozen (no Pro/Max watcher), and a change since may predate the watch.
 */
export const COVER_INTERVALS = 2;
/** wait before the read that confirms a change (a burst of throttling or a CDN hiccup rarely lasts that long) */
export const CONFIRM_DELAY_MS = 5_000;
/** automatic re-checks reserved for a user on a UTC day (seeded from autoRechecksToday the first time) */
export const autoRecheckKey = (userId: string, now: number) => `watch:autorecheck:${userId}:${utcDay(new Date(now))}`;

export interface RecheckDeps {
  env: Env;
  prisma: PrismaClient;
  redis: Redis;
  sources: Sources;
  log: Logger;
  /** queue "checks" with PRIORITY.recheck (jobId = check id) */
  enqueueCheck(checkId: string): Promise<void>;
  /** M4: queue the watch.changed WebhookDelivery rows written with the alerts (QUEUES.webhooks, jobId = delivery id) */
  enqueueWebhooks?(deliveryIds: string[]): Promise<void>;
  now?: () => number;
  /** default CONFIRM_DELAY_MS */
  confirmDelayMs?: number;
}

export type RecheckOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string }
  /** rebaselined: changed since a fingerprint none of the current watchers was covered by (see the header) */
  | { status: 'first' | 'same' | 'unstable' | 'rebaselined' }
  | { status: 'changed'; alerted: number; recheckId: string | null };

const nowOf = (deps: Pick<RecheckDeps, 'now'>) => (deps.now ? deps.now() : Date.now());
const intervalMs = (env: Pick<Env, 'WATCH_RECHECK_HOURS'>) => Math.max(1, env.WATCH_RECHECK_HOURS) * 3600_000;
const startOfUtcDay = (now: number) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/** Watchers who get alerts: Pro and Max (oldest watch first). */
function paidWatchers(prisma: PrismaClient, targetId: string) {
  return prisma.watch.findMany({
    where: { targetId, user: { tier: { in: ['PRO', 'MAX'] } } },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, createdAt: true, lastRecheckAt: true, user: { select: { tier: true } } },
  });
}
type PaidWatcher = Awaited<ReturnType<typeof paidWatchers>>[number];

/** Was this watcher watching while the stored fingerprint was being kept current (see COVER_INTERVALS)? */
export function coveredByBaseline(watchedSince: Date, fingerprintAt: Date | null, env: Pick<Env, 'WATCH_RECHECK_HOURS'>): boolean {
  return !!fingerprintAt && watchedSince.getTime() <= fingerprintAt.getTime() + COVER_INTERVALS * intervalMs(env);
}

/** Targets due for a fingerprint now (see the header), minus those backing off after a failed read. */
export async function scanWatched(deps: RecheckDeps): Promise<string[]> {
  const now = nowOf(deps);
  const cutoff = new Date(now - intervalMs(deps.env) + DUE_SLACK_MS);
  const kinds: Prisma.TargetWhereInput[] = [
    { kind: 'SITE', domain: { not: null } },
    { kind: 'COIN', chain: { not: null }, ca: { not: null } },
  ];
  if (deps.sources.x.configured) kinds.push({ kind: 'POST', handle: { not: null } });
  const rows = await deps.prisma.target.findMany({
    where: {
      AND: [
        { OR: kinds },
        { OR: [{ fingerprintAt: null }, { fingerprintAt: { lt: cutoff } }] },
        { watchers: { some: { user: { tier: { in: ['PRO', 'MAX'] } } } } },
      ],
    },
    orderBy: { fingerprintAt: { sort: 'asc', nulls: 'first' } },
    take: SCAN_MAX,
    select: { id: true },
  });
  if (!rows.length) return [];
  const waiting = await deps.redis.mget(...rows.map(r => retryKey(r.id))).catch(() => rows.map(() => null));
  return rows.filter((_, i) => !waiting[i]).map(r => r.id);
}

/** Automatic re-checks this user got today (UTC): their "changed" alerts that started one. */
export function autoRechecksToday(prisma: PrismaClient, userId: string, now: number): Promise<number> {
  return prisma.notification.count({ where: { userId, kind: NOTIFY_CHANGED, checkId: { not: null }, createdAt: { gte: startOfUtcDay(now) } } });
}

/**
 * Start (or join) a re-check of the target: the input of its latest public verdict, through the shared create path
 * (createCheck + findReusableCheck under the same lock as POST /v1/checks and the bot). null when the target has no
 * public verdict to re-check. The caller queues the job of a check it created.
 */
export async function startAutoRecheck(deps: RecheckDeps, targetId: string, requesterId: string): Promise<{ checkId: string; created: CreatedCheck | null } | null> {
  const { prisma, env } = deps;
  const source = await prisma.check.findFirst({
    where: { targetId, status: 'DONE', isPrivate: false },
    orderBy: { finishedAt: 'desc' },
    select: { targetRaw: true },
  });
  if (!source) return null;
  const d = detect(source.targetRaw);
  if (!d || d.kind === 'bad') return null;
  return withCreateLock(deps.redis, createLockKey(d), async () => {
    const running = await findReusableCheck(prisma, d, { cacheHours: env.CACHE_HOURS, checkBudgetSeconds: env.CHECK_BUDGET_SECONDS, recheck: true, now: nowOf(deps) });
    if (running) return { checkId: running.id, created: null };
    const created = await createCheck(prisma, d, { raw: source.targetRaw, via: 'WEB', requesterId });
    return { checkId: created.id, created };
  });
}

async function backOff(deps: RecheckDeps, targetId: string, seconds: number) {
  await deps.redis.set(retryKey(targetId), '1', 'EX', seconds).catch(() => undefined);
}

/** One watched target: fingerprint, compare, alert (see the header). Never throws for a failed read. */
export async function processRecheck(deps: RecheckDeps, targetId: string): Promise<RecheckOutcome> {
  const { prisma, log } = deps;
  const now = nowOf(deps);
  if (typeof targetId !== 'string' || !targetId) return { status: 'skipped', reason: 'no target id' };
  const t = await prisma.target.findUnique({
    where: { id: targetId },
    select: { id: true, kind: true, chain: true, ca: true, domain: true, handle: true, name: true, fingerprint: true, fingerprintAt: true },
  });
  if (!t) return { status: 'skipped', reason: 'target gone' };
  const watchers = await paidWatchers(prisma, t.id);
  if (!watchers.length) return { status: 'skipped', reason: 'no Pro or Max watcher' };
  if (t.fingerprintAt && now - t.fingerprintAt.getTime() < intervalMs(deps.env) - DUE_SLACK_MS) return { status: 'skipped', reason: 'fingerprinted recently' };
  const kind = fingerprintKind(t);
  if (!kind) return { status: 'skipped', reason: 'not watched for changes' };

  const latest = await prisma.check.findFirst({ where: { targetId: t.id }, orderBy: { createdAt: 'desc' }, select: { targetRaw: true } });
  const read = () => fingerprintTarget(deps.sources, t as WatchedTarget, latest?.targetRaw ?? null);
  const fp = await read();
  if (!fp.ok) {
    await backOff(deps, t.id, fp.retry ? RETRY_AFTER_S : GIVE_UP_FOR_S);
    log.info(`watch ${t.name}: not compared (${fp.reason})`);
    return { status: 'error', reason: fp.reason };
  }
  // first fingerprint (or one taken by another method/version): stored, nothing to compare with
  if (!t.fingerprint || fingerprintScheme(t.fingerprint) !== fingerprintScheme(fp.value)) {
    await prisma.target.updateMany({ where: { id: t.id, fingerprint: t.fingerprint }, data: { fingerprint: fp.value, fingerprintAt: new Date(now) } });
    return { status: 'first' };
  }
  if (fp.value === t.fingerprint) {
    await prisma.target.updateMany({ where: { id: t.id, fingerprint: t.fingerprint }, data: { fingerprintAt: new Date(now) } });
    return { status: 'same' };
  }
  // looks changed: only a second read, a moment later, that agrees makes it a change
  const delay = deps.confirmDelayMs ?? CONFIRM_DELAY_MS;
  if (delay > 0) await new Promise(r => setTimeout(r, delay));
  const again = await read();
  if (!again.ok) {
    await backOff(deps, t.id, again.retry ? RETRY_AFTER_S : GIVE_UP_FOR_S);
    log.info(`watch ${t.name}: change not confirmed (${again.reason})`);
    return { status: 'error', reason: again.reason };
  }
  if (again.value !== fp.value) {
    await prisma.target.updateMany({ where: { id: t.id, fingerprint: t.fingerprint }, data: { fingerprintAt: new Date(now) } });
    return again.value === t.fingerprint ? { status: 'same' } : { status: 'unstable' };
  }
  // only the watchers this fingerprint was the baseline of hear about the change; nobody: it is just replaced
  const covered = watchers.filter(w => coveredByBaseline(w.createdAt, t.fingerprintAt, deps.env));
  if (!covered.length) {
    await prisma.target.updateMany({ where: { id: t.id, fingerprint: t.fingerprint }, data: { fingerprint: fp.value, fingerprintAt: new Date(now) } });
    log.info(`watch ${t.name}: ${kind} differs from a fingerprint none of its ${watchers.length} watcher(s) started from; replaced, nobody alerted`);
    return { status: 'rebaselined' };
  }
  // exactly one run alerts for this change, and its alerts are written in the transaction that moves the stored
  // fingerprint: a failure leaves both as they were, so the next scan finds the change again
  log.info(`watch ${t.name}: ${kind} changed; alerting ${covered.length} watcher(s)`);
  return alertWatchers(deps, t, fp, covered, now);
}

const RESERVE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SET', KEYS[1], ARGV[1]) end
local v = tonumber(redis.call('GET', KEYS[1]))
if v >= tonumber(ARGV[2]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[3]))
return 1
`;
const RELEASE_LUA = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v > 0 then return redis.call('DECR', KEYS[1]) end
return 0
`;
const noop = async () => undefined;

/**
 * Take one of the user's automatic re-checks for today, atomically (two targets changing at once can't both take the
 * last one): a per-user, per-UTC-day counter in Redis that starts from `used` (autoRechecksToday, the durable count)
 * the first time it is touched that day. `release` gives the slot back when no re-check comes of it. A Redis failure
 * falls back to `used` alone.
 */
export async function reserveAutoRecheck(
  deps: Pick<RecheckDeps, 'redis' | 'env'>,
  userId: string,
  used: number,
  now: number,
): Promise<{ ok: boolean; release: () => Promise<void> }> {
  const cap = deps.env.MAX_AUTO_RECHECKS_PER_DAY;
  const key = autoRecheckKey(userId, now);
  const expireAt = Math.floor(nextUtcMidnight(new Date(now)).getTime() / 1000) + 3600;
  try {
    const ok = Number(await deps.redis.eval(RESERVE_LUA, 1, key, used, cap, expireAt)) === 1;
    return { ok, release: ok ? async () => void (await deps.redis.eval(RELEASE_LUA, 1, key).catch(() => undefined)) : noop };
  } catch {
    return { ok: used < cap, release: noop };
  }
}

async function alertWatchers(
  deps: RecheckDeps,
  t: { id: string; name: string; fingerprint: string | null },
  fp: { kind: FingerprintKind; value: string },
  watchers: PaidWatcher[],
  now: number,
): Promise<RecheckOutcome> {
  const { prisma, env, log } = deps;
  const at = new Date(now);
  // 1. the new fingerprint and the alerts, together (compare-and-set: another run that got here first wins); M4: the
  //    watch.changed webhooks of the notified Max users in the same transaction (an alert and its webhooks exist
  //    together or not at all)
  const written = await prisma.$transaction(async tx => {
    const cas = await tx.target.updateMany({ where: { id: t.id, fingerprint: t.fingerprint }, data: { fingerprint: fp.value, fingerprintAt: at } });
    if (!cas.count) return null;
    const rows = await tx.notification.createManyAndReturn({
      data: watchers.map(w => ({ userId: w.userId, targetId: t.id, kind: NOTIFY_CHANGED, checkId: null, text: changedText(t.name, fp.kind, false), createdAt: at })),
      select: { id: true, userId: true },
    });
    await tx.watch.updateMany({ where: { targetId: t.id, userId: { in: watchers.map(w => w.userId) } }, data: { lastAlertAt: at } });
    const deliveries = await watchChangedDeliveries(tx, rows, t.id);
    return { rows, deliveries };
  });
  if (!written) return { status: 'skipped', reason: 'handled by another run' };
  const created = written.rows;
  // the rows are committed: a failed enqueue only delays them (the webhooks worker's sweep queues lost deliveries)
  if (written.deliveries.length && deps.enqueueWebhooks) {
    await deps.enqueueWebhooks(written.deliveries).catch(e => log.warn(`watch ${t.name}: could not queue the watch.changed webhooks: ${errText(e)}`));
  }

  // Max watchers entitled to an automatic re-check now (the alerts just written carry no checkId yet, so they don't
  // count), each with a slot of today's MAX_AUTO_RECHECKS_PER_DAY reserved; every path that starts no re-check gives
  // the slots back
  const eligible: string[] = [];
  const slots: (() => Promise<void>)[] = [];
  const releaseSlots = async () => {
    await Promise.all(slots.splice(0).map(release => release()));
  };
  const unchanged = { status: 'changed', alerted: watchers.length, recheckId: null } as const;
  try {
    for (const w of watchers) {
      if (w.user.tier !== 'MAX') continue;
      if (w.lastRecheckAt && now - w.lastRecheckAt.getTime() < AUTO_RECHECK_GAP_MS) continue;
      const used = await autoRechecksToday(prisma, w.userId, now);
      if (used >= env.MAX_AUTO_RECHECKS_PER_DAY) continue;
      const slot = await reserveAutoRecheck(deps, w.userId, used, now);
      if (!slot.ok) continue;
      eligible.push(w.userId);
      slots.push(slot.release);
    }
  } catch (e) {
    // the alerts are out; without a re-check they say only what changed
    log.error(`watch ${t.name}: could not tell who gets an automatic re-check`, e);
    await releaseSlots();
    return unchanged;
  }
  if (!eligible.length) return unchanged;

  // 2. Max: one automatic re-check between them (or the run of the target already in progress), linked to their
  //    alerts BEFORE its job is queued: that link is how the check's end finds whom to tell (notify.ts)
  let recheck: { checkId: string; created: CreatedCheck | null } | null = null;
  try {
    recheck = await startAutoRecheck(deps, t.id, eligible[0]);
  } catch (e) {
    log.error(`watch ${t.name}: the automatic re-check could not be started`, e);
  }
  if (!recheck) {
    await releaseSlots();
    return unchanged;
  }
  const ids = created.filter(n => eligible.includes(n.userId)).map(n => n.id);
  const unlink = async () => {
    await prisma.notification.updateMany({ where: { id: { in: ids } }, data: { checkId: null, text: changedText(t.name, fp.kind, false) } }).catch(() => undefined);
    await prisma.watch.updateMany({ where: { targetId: t.id, userId: { in: eligible } }, data: { lastRecheckAt: null } }).catch(() => undefined);
  };
  try {
    await prisma.$transaction([
      prisma.notification.updateMany({ where: { id: { in: ids } }, data: { checkId: recheck.checkId, text: changedText(t.name, fp.kind, true) } }),
      prisma.watch.updateMany({ where: { targetId: t.id, userId: { in: eligible } }, data: { lastRecheckAt: at } }),
    ]);
    if (recheck.created) await deps.enqueueCheck(recheck.checkId);
  } catch (e) {
    log.error(`watch ${t.name}: the automatic re-check could not be queued`, e);
    // no re-check is coming: the check ends FAILED, the alerts say only what changed, the watches may be re-checked next time
    if (recheck.created) await failUnqueuedCheck(prisma, recheck.created).catch(() => undefined);
    await unlink();
    await releaseSlots();
    return unchanged;
  }
  log.info(`watch ${t.name}: automatic re-check ${recheck.checkId} ${recheck.created ? 'queued' : 'joined'} for ${eligible.length} Max watcher(s)`);
  if (!recheck.created) {
    // the joined run may have finished while the alerts were written (its own end found nobody linked yet): complete
    // them now, and send the linked watchers' check.completed webhooks (both idempotent)
    const st = await prisma.check.findUnique({ where: { id: recheck.checkId }, select: { status: true } });
    if (st && (st.status === 'DONE' || st.status === 'FAILED')) {
      await completeAutoRechecks(deps, recheck.checkId).catch(e => log.warn(`could not complete the re-check alerts: ${errText(e)}`));
      await completedWebhooks(deps, recheck.checkId).catch(e => log.warn(`could not queue the re-check's check.completed webhooks (the webhooks sweep catches up): ${errText(e)}`));
    }
  }
  return { status: 'changed', alerted: watchers.length, recheckId: recheck.checkId };
}

/** check.completed of a finished check (webhooks/events.ts), queued when the webhooks queue is wired. */
async function completedWebhooks(deps: RecheckDeps, checkId: string) {
  const joiners = await readJoiners(deps.redis, checkId, deps.log);
  const ids = await checkCompletedDeliveries(deps.prisma, checkId, { joiners });
  if (ids.length && deps.enqueueWebhooks) await deps.enqueueWebhooks(ids);
}

/** queue "checks" options of an automatic re-check */
export const RECHECK_CHECK_JOB = { priority: PRIORITY.recheck, ...CHECK_JOB_OPTIONS };
