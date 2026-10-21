/**
 * Shared check creation (HANDOFF §4 Stage A cache, §7 bot): the one place that decides whether a target already has
 * a check that answers it, and that creates Target + Check rows. POST /v1/checks (apps/api) and the X bot
 * (apps/worker/src/bot) both call it, so "same target", "still running" and "fresh enough" mean the same thing on
 * the site and on X. Callers keep their own concerns: the API spends and refunds credits, both enqueue the job.
 *
 * Race rule: wrap findReusableCheck() + createCheck() in withCreateLock(redis, createLockKey(d), …) — the same key
 * on both sides — so a site submit and a bot tag of the same project can't start two checks.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { short, targetKey, type Detected } from '@apecheck/core';
import type { Prisma, PrismaClient, Via } from '@prisma/client';

export type CheckTarget = Exclude<Detected, { kind: 'bad' }>;

/* ---------------- "same target" ---------------- */

/**
 * Target rows that are the same project as the input. Coins match on the address across every chain key
 * (incl. the preliminary "ca:evm:" one), sites on the domain, posts on the tweet id, X profiles on the handle key.
 */
export function sameTargetWhere(d: CheckTarget): Prisma.TargetWhereInput {
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

/**
 * Checks of the same project: the target rule above, plus any check of the same X post id, plus any check of the same
 * pasted or tagged EVM contract (Check.targetRaw, any case). The worker moves a contract that trades only on a chain
 * ApeCheck can't read (Sonic, Polygon…) to the website in its token info, so that check's Target is the site, not
 * the contract: without the targetRaw match every paste of the same contract would run (and spend) a new check.
 */
export function sameCheckWhere(d: CheckTarget): Prisma.CheckWhereInput {
  if (d.kind === 'xpost' && d.postId) return { OR: [{ postId: d.postId }, { target: { key: targetKey(d) } }] };
  if (d.kind === 'evm') return { OR: [{ target: sameTargetWhere(d) }, { targetRaw: { equals: d.address, mode: 'insensitive' } }] };
  return { target: sameTargetWhere(d) };
}

/** Preliminary Target fields until the worker resolves the project. */
export function targetSeed(d: CheckTarget): Pick<Prisma.TargetCreateInput, 'kind' | 'chain' | 'ca' | 'domain' | 'handle' | 'name' | 'key'> {
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

/* ---------------- running / cached ---------------- */

/**
 * Queued/running checks that can still finish. A run older than twice the check budget (or a job queued for
 * hours) is treated as dead: it must not block new checks or sit on /v1/live forever.
 */
export const QUEUED_STALE_MS = 2 * 3600_000;
export function activeCheckWhere(cfg: { CHECK_BUDGET_SECONDS: number }, now = Date.now()): Prisma.CheckWhereInput {
  const runCut = new Date(now - (cfg.CHECK_BUDGET_SECONDS * 2 + 60) * 1000);
  return {
    OR: [
      { status: 'RUNNING', OR: [{ startedAt: { gte: runCut } }, { startedAt: null, createdAt: { gte: runCut } }] },
      { status: 'QUEUED', createdAt: { gte: new Date(now - QUEUED_STALE_MS) } },
    ],
  };
}

export interface ReusableCheck {
  id: string;
  shortId: string;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  finishedAt: Date | null;
  /** running: a public run of the same target is in progress; cached: a public verdict younger than CACHE_HOURS */
  reason: 'running' | 'cached';
}

export interface ReuseOptions {
  /** env.CACHE_HOURS */
  cacheHours: number;
  /** env.CHECK_BUDGET_SECONDS (how long a run may look alive) */
  checkBudgetSeconds: number;
  /** Re-check: skip the cache (a run in progress is still returned: it is as fresh as it gets) */
  recheck?: boolean;
  /** M3: a private request by this user: their own private checks count too */
  privateFor?: string | null;
  now?: number;
}

/**
 * The check that already answers this target, or null when a new one has to run:
 *  1. a public check of the same target that is queued or running (also for Re-check), else
 *  2. unless `recheck`, the newest public DONE check of the same target that finished less than CACHE_HOURS ago.
 * Other people's private checks are never reused. A private request (`privateFor` = the requesting user, M3) also
 * reuses that user's own private checks by the same rules (a double submit doesn't start two); returning a public
 * check to it is harmless: it is public already.
 */
export async function findReusableCheck(prisma: PrismaClient | Prisma.TransactionClient, d: CheckTarget, opts: ReuseOptions): Promise<ReusableCheck | null> {
  const now = opts.now ?? Date.now();
  const same = sameCheckWhere(d);
  const visible: Prisma.CheckWhereInput = opts.privateFor
    ? { OR: [{ isPrivate: false }, { isPrivate: true, requesterId: opts.privateFor }] }
    : { isPrivate: false };
  const select = { id: true, shortId: true, status: true, finishedAt: true } as const;
  const active = await prisma.check.findFirst({
    where: { AND: [same, activeCheckWhere({ CHECK_BUDGET_SECONDS: opts.checkBudgetSeconds }, now), visible] },
    orderBy: { createdAt: 'desc' },
    select,
  });
  if (active) return { ...active, reason: 'running' };
  if (opts.recheck) return null;
  const fresh = await prisma.check.findFirst({
    where: { AND: [same, visible, { status: 'DONE', finishedAt: { gte: new Date(now - opts.cacheHours * 3600_000) } }] },
    orderBy: { finishedAt: 'desc' },
    select,
  });
  return fresh ? { ...fresh, reason: 'cached' } : null;
}

/* ---------------- create ---------------- */

const SHORT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 7 random [a-z0-9] chars: the public id in /c/[id] and card URLs. */
export function randomShortId(len = 7): string {
  let s = '';
  for (let i = 0; i < len; i++) s += SHORT_ALPHABET[randomInt(SHORT_ALPHABET.length)];
  return s;
}

async function uniqueShortId(prisma: PrismaClient): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const id = randomShortId();
    const hit = await prisma.check.findUnique({ where: { shortId: id }, select: { id: true } });
    if (!hit) return id;
  }
  throw new Error('could not allocate a unique shortId');
}

export interface CreateCheckInput {
  /** what the user pasted / what the bot resolved (stored as Check.targetRaw, max 2048 chars) */
  raw: string;
  via: Via;
  requesterId?: string | null;
  /** anonymous session id (site) */
  requesterSid?: string | null;
  /** X handle without "@" (bot) */
  requesterHandle?: string | null;
  /**
   * M3: a Max user's private check: visible only to its requester and kept out of every public list. It doesn't
   * count towards Target.checkCount ("Most checked"), which would reveal it.
   */
  isPrivate?: boolean;
}

export interface CreatedCheck {
  id: string;
  shortId: string;
  targetId: string;
  isPrivate: boolean;
}

/**
 * A QUEUED Check of `d` (public unless `input.isPrivate`), on the project's existing Target when there is one (e.g. an
 * EVM coin the worker already re-keyed to its chain), else on a new Target with preliminary fields. Target.checkCount
 * +1 for a public check. One transaction. `postId` is set whenever the input is an X post.
 */
export async function createCheck(prisma: PrismaClient, d: CheckTarget, input: CreateCheckInput): Promise<CreatedCheck> {
  const shortId = await uniqueShortId(prisma);
  const seed = targetSeed(d);
  const isPrivate = !!input.isPrivate;
  const bump = isPrivate ? 0 : 1;
  return prisma.$transaction(async tx => {
    const existing = await tx.target.findFirst({
      where: sameTargetWhere(d),
      orderBy: [{ chain: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: { id: true },
    });
    const target = existing
      ? await tx.target.update({ where: { id: existing.id }, data: { checkCount: { increment: bump } }, select: { id: true } })
      : await tx.target.upsert({
          where: { key: seed.key },
          create: { ...seed, checkCount: bump },
          update: { checkCount: { increment: bump } },
          select: { id: true },
        });
    return tx.check.create({
      data: {
        shortId,
        targetId: target.id,
        targetRaw: input.raw.trim().slice(0, 2048),
        postId: d.kind === 'xpost' ? d.postId : null,
        status: 'QUEUED',
        via: input.via,
        requesterId: input.requesterId ?? null,
        requesterSid: input.requesterSid ?? null,
        requesterHandle: input.requesterHandle ?? null,
        isPrivate,
      },
      select: { id: true, shortId: true, targetId: true, isPrivate: true },
    });
  });
}

/** A check whose job could not be queued: FAILED with a plain reason, and its Target's checkCount given back (public checks only counted). */
export async function failUnqueuedCheck(
  prisma: PrismaClient,
  check: { id: string; targetId: string; isPrivate?: boolean },
  error = 'Could not queue the check',
): Promise<void> {
  await prisma.$transaction([
    prisma.check.update({ where: { id: check.id }, data: { status: 'FAILED', error, finishedAt: new Date() } }),
    ...(check.isPrivate ? [] : [prisma.target.update({ where: { id: check.targetId }, data: { checkCount: { decrement: 1 } } })]),
  ]);
}

/* ---------------- create lock ---------------- */

/** The few Redis commands the lock needs (an ioredis client satisfies it). */
export interface LockRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** The lock both the API and the bot take around findReusableCheck + createCheck. */
export const createLockKey = (d: CheckTarget) => `lock:create:${targetKey(d)}`;

const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Short Redis mutex: run `fn` holding `key`. If the lock can't be taken within `waitMs` (a stuck holder), `fn`
 * runs anyway: the lock only narrows a race, it never blocks a check.
 */
export async function withCreateLock<T>(redis: LockRedis, key: string, fn: () => Promise<T>, opts: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const ttlMs = opts.ttlMs ?? 10_000;
  const deadline = Date.now() + (opts.waitMs ?? 3_000);
  const token = randomBytes(12).toString('hex');
  let held = false;
  try {
    for (;;) {
      held = (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
      if (held || Date.now() >= deadline) break;
      await sleep(40);
    }
  } catch {
    held = false;
  }
  try {
    return await fn();
  } finally {
    if (held) await redis.eval(RELEASE_LUA, 1, key, token).catch(() => undefined);
  }
}
