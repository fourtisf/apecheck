/**
 * One mention, from storing it to the reply job (HANDOFF §7, §11). Every mention is stored as a BotMention (unique
 * tweet id) BEFORE anything is decided; whoever inserts the row handles it, exactly once. A mention that was already
 * stored is never handled again, so nothing is answered twice — except one whose handling was cut off (a crash, a
 * transient database/Redis error) while it was still RECEIVED: it is handled on the next poll (storeMention).
 *
 * Order of the rules:
 *  1. ignored, no reply: the bot itself, retweets, mentions older than TUNING.botMaxMentionAgeHours, accounts younger
 *     than TUNING.botMinAccountAgeDays;
 *  2. a reply to (or a quote of) one of the bot's own verdict (or follow-up) posts is a follow-up about that check: a
 *     Pro/Max author (User.xUserId) gets an answer from the check's stored data; anyone else one line pointing to the
 *     site, once per thread. The bot is in X's reply prefix there, so this comes before rule 3. Tagging the bot there
 *     together with a new link, contract or X post (or a bare "@ApeCheckBot @project") asks for a check of that
 *     instead (rules 4–5); an @handle inside a question does not. Tagging the bot under its "Couldn't finish this
 *     check" line runs that check's target again;
 *  3. ignored: the author didn't type the bot's handle (it is only in X's reply prefix: someone chatting further down
 *     a thread the bot is in) — unless the post answers the bot's help line directly;
 *  4. what to check: a link / contract / X post written in the mention; else, for a reply to an earlier tag that got a
 *     check, that tag's target (a second tag in the thread never checks the person who tagged first); else
 *     resolveBotTarget() (resolve.ts), reading the parent post (and, when the parent is a tag that names nothing,
 *     the post above it) when X didn't include it. When only a post's author (or nothing) is found and the thread
 *     already has a check, that check. Nothing to check → the help line, at most once per thread;
 *  5. a target → one check: the same target in this thread (running, or done at any age), else the shared
 *     findReusableCheck (running, or a verdict younger than CACHE_HOURS), else a new check (via BOT, PRIORITY.bot).
 *     A finished check is answered at once; a running one is answered when Stage F enqueues the reply of every
 *     QUEUED mention linked to it. The same person tagging again in the same thread for the same check gets no second
 *     reply (the thread already has, or will get, theirs; X also refuses a repeated post); another person's tag in
 *     the thread gets its own reply with the same verdict.
 * Rules 2, 4 and 5 count against the hourly limits (limits.ts) before anything is started.
 */
import { TUNING, detect, targetKey, type Env } from '@apecheck/core';
import { activeCheckWhere, createCheck, createLockKey, failUnqueuedCheck, findReusableCheck, withCreateLock, type BotMention, type PrismaClient } from '@apecheck/db';
import type { XPost, XSource } from '@apecheck/sources';
import type { Redis } from 'ioredis';
import type { AiAdapter } from '../ai/types';
import type { Logger } from '../log';
import { errText } from '../log';
import { pgText } from '../pipeline/pgsafe';
import { composePointer, type ComposeOpts } from './compose';
import { reserveReply } from './limits';
import { isFromBot, isRetweet, ownText, parentOwnText, questionText, replyExcludeIds, tagsBot, type BotIdentity } from './mention';
import { resolveBotTarget, type BotResolution, type BotTargetType } from './resolve';

export interface BotDeps {
  env: Env;
  prisma: PrismaClient;
  /** commands (limits, since_id, lock, posted markers) */
  redis: Redis;
  /** needs mentions() and reply() (M2) */
  x: XSource;
  ai: AiAdapter;
  log: Logger;
  /** queue "checks", PRIORITY.bot */
  enqueueCheck(checkId: string): Promise<void>;
  /** queue "bot-replies", jobId = mention id */
  enqueueReply(mentionId: string): Promise<void>;
  /** share card PNG when SCREENSHOT_DIR has none; default GET WEB_INTERNAL_URL/card/<shortId>.png (5 s) */
  fetchCard?: (shortId: string) => Promise<Buffer | null>;
  now?: () => number;
}

export type MentionOutcome =
  | { action: 'duplicate' }
  | { action: 'ignored'; reason: string }
  | { action: 'help' }
  | { action: 'followup'; pro: boolean }
  | { action: 'check'; checkId: string; reuse: 'thread' | 'running' | 'cached' | null; replyNow: boolean; target: string }
  | { action: 'failed'; reason: string };

export const botIdentity = (env: Pick<Env, 'X_BOT_HANDLE' | 'X_BOT_USER_ID'>): BotIdentity => ({
  handle: env.X_BOT_HANDLE.replace(/^@+/, ''),
  userId: env.X_BOT_USER_ID ?? null,
});
export const composeOpts = (env: Pick<Env, 'BOT_INCLUDE_LINK' | 'APP_URL'>): ComposeOpts => ({ includeLink: env.BOT_INCLUDE_LINK, appUrl: env.APP_URL });

const nowOf = (deps: BotDeps) => (deps.now ? deps.now() : Date.now());

type Row = Pick<BotMention, 'id' | 'tweetId' | 'authorId' | 'authorHandle' | 'conversationId' | 'text'>;

/**
 * Insert the mention (status RECEIVED). Returns the row when this call inserted it — or when it was stored before but
 * its handling was cut off (still RECEIVED, no lease) — and null when it was already stored (it is then never
 * handled again). Throws MentionBusyError for a RECEIVED mention whose lease is held, and other database errors: the
 * caller stops and keeps since_id, so the mention is read again next time.
 */
export async function storeMention(deps: BotDeps, post: XPost): Promise<Row | null> {
  const bot = botIdentity(deps.env);
  const own = ownText(post, bot, post.repliedTo);
  // INSERT … ON CONFLICT DO NOTHING: of two deliveries (or two pollers) exactly one inserts the row and handles it
  const inserted = await deps.prisma.botMention.createMany({
    data: [
      {
        tweetId: post.id,
        authorId: post.authorId || 'unknown',
        authorHandle: pgText(post.authorHandle ?? post.author?.handle ?? ''),
        // what the author typed (X's reply prefix left out): what the /bot page shows and a follow-up asks
        text: pgText(own).slice(0, 4000),
        // an account that tagged the bot (/v1/bot/stats): it typed the handle itself, whatever happens next (a
        // stale or rate-limited tag still counts); not X's reply prefix, a retweet of someone's tag or the bot itself
        tagged: !isFromBot(post, bot) && !isRetweet(post) && tagsBot(own, bot),
        inReplyToId: post.replyToId ?? null,
        conversationId: post.conversationId ?? null,
        // everyone X would add to the reply but the asker: the reply job leaves them out (HANDOFF §7)
        replyExcludeIds: replyExcludeIds(post, bot),
        isFollowUp: false,
        status: 'RECEIVED',
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count) {
    // ours to handle; the lease only tells a later poll that someone is on it (best effort: we inserted the row)
    await deps.redis.set(leaseKey(post.id), '1', 'EX', LEASE_SECONDS, 'NX').catch(() => undefined);
  } else {
    // already stored: handled, or being handled — unless it is still RECEIVED and nobody holds its lease (the
    // process handling it died, or a transient error let go of it): then it is handled now, so it is not lost
    const stored = await deps.prisma.botMention.findUnique({ where: { tweetId: post.id }, select: { status: true } });
    if (stored?.status !== 'RECEIVED') return null;
    if ((await deps.redis.set(leaseKey(post.id), '1', 'EX', LEASE_SECONDS, 'NX')) !== 'OK') throw new MentionBusyError(post.id);
    deps.log.warn(`mention ${post.id} was stored but its handling was cut off: handling it now`);
  }
  return deps.prisma.botMention.findUniqueOrThrow({
    where: { tweetId: post.id },
    select: { id: true, tweetId: true, authorId: true, authorHandle: true, conversationId: true, text: true },
  });
}

/** Held (SET NX EX) while a mention is handled; a RECEIVED mention without it was cut off and is handled again. */
export const leaseKey = (tweetId: string) => `bot:handling:${tweetId}`;
const LEASE_SECONDS = 120;

/** A stored mention another handler holds (or one cut off less than LEASE_SECONDS ago): the poll stops, since_id kept. */
export class MentionBusyError extends Error {
  constructor(tweetId: string) {
    super(`mention ${tweetId} is still being handled`);
    this.name = 'MentionBusyError';
  }
}

/**
 * The database or Redis was briefly unreachable (Prisma connection/pool errors, ioredis connection errors): the
 * mention is left for the next poll instead of being marked FAILED.
 */
export function isTransientError(e: unknown): boolean {
  const err = (e ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  if (['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'].includes(code)) return true;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true;
  const name = typeof err.name === 'string' ? err.name : '';
  if (['PrismaClientInitializationError', 'PrismaClientRustPanicError', 'MaxRetriesPerRequestError'].includes(name)) return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return /Connection is closed|Stream isn't writeable|max retries per request|ECONNREFUSED|ECONNRESET|Can't reach database server|Timed out fetching a new connection/i.test(msg);
}

/**
 * Store, then handle. A transient database / Redis error leaves the mention RECEIVED and is thrown: the poll stops and
 * keeps since_id, and the next poll handles the mention again (storeMention). Any other error marks it FAILED.
 */
export async function handleMention(deps: BotDeps, post: XPost): Promise<MentionOutcome> {
  const row = await storeMention(deps, post);
  if (!row) return { action: 'duplicate' };
  try {
    return await processMention(deps, row, post);
  } catch (e) {
    if (isTransientError(e)) {
      deps.log.warn(`mention ${post.id}: ${errText(e)}; it is handled again on the next poll`);
      await deps.redis.del(leaseKey(post.id)).catch(() => undefined);
      throw e;
    }
    deps.log.error(`mention ${post.id} could not be handled`, e);
    const reason = `processing error: ${errText(e)}`.slice(0, 300);
    await deps.prisma.botMention
      .updateMany({ where: { id: row.id, status: { in: ['RECEIVED', 'QUEUED'] } }, data: { status: 'FAILED', ignoreReason: reason } })
      .catch(() => undefined);
    return { action: 'failed', reason };
  }
}

async function ignore(deps: BotDeps, row: Row, reason: string, extra: { checkId?: string | null; targetKey?: string | null; isFollowUp?: boolean } = {}): Promise<MentionOutcome> {
  await deps.prisma.botMention.update({ where: { id: row.id }, data: { status: 'IGNORED', kind: 'ignored', ignoreReason: reason, ...extra } });
  deps.log.info(`mention ${row.tweetId} by @${row.authorHandle} ignored: ${reason}`);
  return { action: 'ignored', reason };
}

async function accountAgeDays(deps: BotDeps, post: XPost, now: number): Promise<number | null> {
  let created = post.author?.createdAt ?? null;
  if (!created && post.authorId) created = (await deps.x.getUserById(post.authorId).catch(() => null))?.createdAt ?? null;
  const t = created ? Date.parse(created) : NaN;
  return Number.isFinite(t) ? (now - t) / 86_400_000 : null;
}

async function linkedUser(deps: BotDeps, authorId: string) {
  const user = await deps.prisma.user.findUnique({ where: { xUserId: authorId }, select: { id: true, tier: true } }).catch(() => null);
  if (user) {
    // an X-linked user who uses the bot is "seen" (at most one write an hour): the hourly tier refresh
    // (maintenance/tiers.ts) then keeps the tier these limits and follow-ups read current
    const now = nowOf(deps);
    await deps.prisma.user
      .updateMany({ where: { id: user.id, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now - 3600_000) } }] }, data: { lastSeenAt: new Date(now) } })
      .catch(() => undefined);
  }
  return user;
}

/** Count the reply against the hourly limits; false (and the mention ignored) when over. */
async function reserve(deps: BotDeps, row: Row, pro: boolean, now: number): Promise<MentionOutcome | null> {
  const r = await reserveReply(deps.redis, {
    authorId: row.authorId,
    userLimit: pro ? deps.env.BOT_PRO_USER_HOURLY : deps.env.BOT_USER_HOURLY,
    globalCap: deps.env.BOT_HOURLY_CAP,
    now,
  });
  return r.ok ? null : ignore(deps, row, r.reason);
}

/** The stored mention whose reply is the bot's post `tweetId` (null: not one of the bot's replies). */
function botPostOf(deps: BotDeps, tweetId: string) {
  return deps.prisma.botMention.findFirst({
    where: { replyTweetId: tweetId },
    select: { kind: true, checkId: true, targetKey: true, check: { select: { shortId: true, status: true, targetRaw: true } } },
  });
}

/** The BotTargetType of a raw target (for a target taken from a stored check). */
function typeOf(raw: string): BotTargetType {
  const d = detect(raw);
  if (!d || d.kind === 'bad') return 'site';
  if (d.kind === 'evm' || d.kind === 'sol' || d.kind === 'tron') return 'contract';
  if (d.kind === 'xpost') return d.postId ? 'xpost' : 'handle';
  return 'site';
}

/**
 * Under the bot's post about a check, does the mention ask for a check of something else? Only a link, contract or
 * X post of its own with another target key — or an @handle typed with nothing else ("@ApeCheckBot @kairolabs").
 * "@ApeCheckBot is the @orbitxyz team doxxed?" is a question about the check, not a new target.
 */
function isNewTarget(r: BotResolution, own: string, bot: BotIdentity, parentKey: string | null): boolean {
  if (r.kind !== 'target') return false;
  if (r.type === 'handle') {
    const rest = questionText(own, bot).replace(/[@＠][A-Za-z0-9_]{1,15}/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    if (rest) return false;
  }
  const d = detect(r.target);
  return !!d && d.kind !== 'bad' && targetKey(d) !== parentKey;
}

/**
 * The public check this conversation already has (running, or done at any age): the one a tag directly under the
 * thread's first post got, else the oldest — a thread is about its first post's project.
 */
async function threadCheck(deps: BotDeps, row: Row, now: number): Promise<{ targetRaw: string; targetKey: string } | null> {
  const rows = await deps.prisma.botMention.findMany({
    where: {
      id: { not: row.id },
      conversationId: row.conversationId,
      checkId: { not: null },
      targetKey: { not: null },
      check: { is: { isPrivate: false, OR: [{ status: 'DONE' }, activeCheckWhere(deps.env, now)] } },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { inReplyToId: true, targetKey: true, check: { select: { targetRaw: true } } },
  });
  const pick = rows.find(r => r.inReplyToId && r.inReplyToId === row.conversationId) ?? rows[0];
  return pick?.check && pick.targetKey ? { targetRaw: pick.check.targetRaw, targetKey: pick.targetKey } : null;
}

export async function processMention(deps: BotDeps, row: Row, post: XPost): Promise<MentionOutcome> {
  const { prisma, env } = deps;
  const bot = botIdentity(env);
  const now = nowOf(deps);

  // 1. never answered
  if (isFromBot(post, bot)) return ignore(deps, row, 'self');
  if (isRetweet(post)) return ignore(deps, row, 'retweet');
  const postedAt = post.createdAt ? Date.parse(post.createdAt) : NaN;
  if (Number.isFinite(postedAt) && now - postedAt > TUNING.botMaxMentionAgeHours * 3600_000) return ignore(deps, row, 'stale');
  const age = await accountAgeDays(deps, post, now);
  if (age == null) deps.log.info(`mention ${post.id}: account age of ${post.authorId} unknown; not held against it`);
  else if (age < TUNING.botMinAccountAgeDays) return ignore(deps, row, 'young_account');

  const user = await linkedUser(deps, row.authorId);
  const pro = user?.tier === 'PRO' || user?.tier === 'MAX';

  const own = ownText(post, bot, post.repliedTo);
  const tagged = tagsBot(own, bot);

  // the bot's own post this mention answers: the one it replies to, else the one it quotes while tagging the bot (a
  // quote alone is not a mention: never answered)
  const replyToBot = post.replyToId ? await botPostOf(deps, post.replyToId) : null;
  const quotesBot = !replyToBot && tagged && post.quotedId ? await botPostOf(deps, post.quotedId) : null;
  const botPost = replyToBot ?? quotesBot;
  const botPostIds = new Set([replyToBot ? post.replyToId! : null, quotesBot ? post.quotedId! : null].filter((id): id is string => !!id));
  // a link, contract or X post the author wrote in the mention itself (an @handle alone is weaker: see resolve.ts)
  const mine = resolveBotTarget(post, null, bot, { botPostIds });
  const mineStrong = mine.kind === 'target' && mine.type !== 'handle' ? mine : null;

  // 2. a reply to (or a quote of) one of the bot's own posts about a check — unless the author tagged the bot
  //    together with a new link, contract or X post of their own: that asks for a check of it (rules 4–5)
  let retry: BotResolution | null = null;
  if (botPost?.checkId && botPost.check && (botPost.kind === 'check' || botPost.kind === 'followup')) {
    if (!(tagged && isNewTarget(mine, own, bot, botPost.targetKey))) {
      // the bot's "Couldn't finish this check. Try again in a few minutes.": tagging it there is the retry
      if (botPost.check.status !== 'DONE' && tagged) {
        retry = { kind: 'target', target: botPost.check.targetRaw, type: typeOf(botPost.check.targetRaw), from: 'replied', reason: 'a retry of the check that could not finish' };
      } else {
        return followUp(deps, row, post, { checkId: botPost.checkId, targetKey: botPost.targetKey, ...botPost.check }, pro, now);
      }
    }
  }

  // 3. the author has to have typed the bot's handle — or be answering the bot's help line ("include its link or
  //    contract"), where the bot is only in X's reply prefix
  if (!tagged && replyToBot?.kind !== 'help') return ignore(deps, row, 'not_tagged');

  // 4. what to check
  let res: BotResolution | null = mineStrong ?? retry;
  // the key of the thread's check when the target comes from it (its stored mention), else targetKey(detect(target))
  let threadKey: string | null = null;
  if (!res && post.replyToId && !replyToBot) {
    // a reply to an earlier tag that got a check (a second tag in the thread): the same target, so the thread rules
    // below join that check instead of starting another one (and never check the person who tagged)
    const prevTag = await prisma.botMention.findUnique({
      where: { tweetId: post.replyToId },
      select: { targetKey: true, checkId: true, check: { select: { targetRaw: true } } },
    });
    if (prevTag?.checkId && prevTag.check && prevTag.targetKey) {
      res = { kind: 'target', target: prevTag.check.targetRaw, type: typeOf(prevTag.check.targetRaw), from: 'replied', reason: 'the check of the tag it replies to' };
      threadKey = prevTag.targetKey;
    }
  }
  let parentPost = post.repliedTo ?? null;
  if (!res) {
    if (!parentPost && post.replyToId && !replyToBot) {
      // X didn't include the parent with the mention (it usually does, through the mentions request's expansions): read it
      // through the free embed endpoints, never a paid X API read (a parent X left out is mostly deleted or protected,
      // which a paid read can't see either)
      parentPost = await deps.x.getPost(post.replyToId).catch(() => null);
    }
    res = resolveBotTarget(post, parentPost, bot, { botPostIds });
    if (res.kind === 'up') {
      // the parent is a tag of the bot that names nothing: what it was asking about is the post above it (free read too)
      const above = await deps.x.getPost(res.postId).catch(() => null);
      res = resolveBotTarget(post, parentPost, bot, { botPostIds, above });
    }
    const parentIsTag = !!parentPost && !isFromBot(parentPost, bot) && tagsBot(parentOwnText(parentPost), bot);
    if (row.conversationId && ((res.kind === 'target' && res.from === 'author') || (res.kind !== 'target' && parentIsTag))) {
      // only a post's author (or nothing) found: when this thread already has a check, that check is what the
      // thread is about (a tag under the project's own "2/" post, under a reply in the thread, under an unanswered tag)
      const thread = await threadCheck(deps, row, now);
      if (thread) {
        res = { kind: 'target', target: thread.targetRaw, type: typeOf(thread.targetRaw), from: 'replied', reason: 'the check this thread already has' };
        threadKey = thread.targetKey;
      }
    }
  }
  if (res.kind !== 'target') return help(deps, row, pro, now, res.reason);
  const d = detect(res.target);
  if (!d || d.kind === 'bad') return help(deps, row, pro, now, `unrecognised target ${res.target}`);
  // the bot's own posts are never checked (a link or quote of one the URL didn't give away)
  if (d.kind === 'xpost' && d.postId && (botPostIds.has(d.postId) || (await botPostOf(deps, d.postId)))) {
    return help(deps, row, pro, now, `the bot's own post ${d.postId} is not a target`);
  }
  deps.log.info(`mention ${post.id} by @${row.authorHandle}: ${res.reason} → ${res.target}`);

  // 5. one check per target
  const key = threadKey ?? targetKey(d);
  if (row.conversationId) {
    const answered = await prisma.botMention.findFirst({
      where: {
        id: { not: row.id },
        conversationId: row.conversationId,
        authorId: row.authorId,
        targetKey: key,
        kind: 'check',
        status: { in: ['QUEUED', 'REPLIED'] },
        // "Couldn't finish this check. Try again in a few minutes.": a re-tag after that is the retry
        check: { is: { status: { not: 'FAILED' } } },
      },
      select: { checkId: true },
    });
    if (answered) return ignore(deps, row, 'answered_in_thread', { checkId: answered.checkId, targetKey: key });
  }
  const over = await reserve(deps, row, pro, now);
  if (over) return over;

  const linked = await withCreateLock(deps.redis, createLockKey(d), async () => {
    let reuse: { id: string; reason: 'thread' | 'running' | 'cached' } | null = null;
    if (row.conversationId) {
      // this thread already has a check of the same target: running, or done (at any age)
      const prior = await prisma.botMention.findFirst({
        where: {
          id: { not: row.id },
          conversationId: row.conversationId,
          targetKey: key,
          check: { is: { isPrivate: false, OR: [{ status: 'DONE' }, activeCheckWhere(env, now)] } },
        },
        orderBy: { createdAt: 'desc' },
        select: { checkId: true },
      });
      if (prior?.checkId) reuse = { id: prior.checkId, reason: 'thread' };
    }
    if (!reuse) {
      const r = await findReusableCheck(prisma, d, { cacheHours: env.CACHE_HOURS, checkBudgetSeconds: env.CHECK_BUDGET_SECONDS, now });
      if (r) reuse = { id: r.id, reason: r.reason };
    }
    if (reuse) {
      await prisma.botMention.update({ where: { id: row.id }, data: { checkId: reuse.id, targetKey: key, kind: 'check', status: 'QUEUED' } });
      return { checkId: reuse.id, created: null, reuse: reuse.reason };
    }
    const created = await createCheck(prisma, d, {
      raw: res.target,
      via: 'BOT',
      requesterHandle: row.authorHandle.replace(/^@+/, '') || null,
      requesterId: user?.id ?? null,
    });
    // linked before the job is queued, so even an instant finish finds this mention QUEUED and replies to it
    await prisma.botMention.update({ where: { id: row.id }, data: { checkId: created.id, targetKey: key, kind: 'check', status: 'QUEUED' } });
    return { checkId: created.id, created, reuse: null };
  });

  if (linked.created) {
    try {
      await deps.enqueueCheck(linked.checkId);
    } catch (e) {
      deps.log.error(`check ${linked.checkId} could not be queued`, e);
      // the check can't run: it ends FAILED and the reply says to try again (if the reply queue is up)
      await failUnqueuedCheck(prisma, linked.created).catch(() => undefined);
    }
  }
  // finished (a cached verdict, or a run that ended meanwhile): reply now; still running: Stage F replies
  const state = await prisma.check.findUnique({ where: { id: linked.checkId }, select: { status: true } });
  const replyNow = state?.status === 'DONE' || state?.status === 'FAILED';
  if (replyNow) await deps.enqueueReply(row.id);
  return { action: 'check', checkId: linked.checkId, reuse: linked.reuse, replyNow, target: res.target };
}

async function help(deps: BotDeps, row: Row, pro: boolean, now: number, why: string): Promise<MentionOutcome> {
  deps.log.info(`mention ${row.tweetId} by @${row.authorHandle}: ${why}`);
  if (row.conversationId) {
    const sent = await deps.prisma.botMention.findFirst({
      where: { id: { not: row.id }, conversationId: row.conversationId, kind: 'help', status: { in: ['QUEUED', 'REPLIED'] } },
      select: { id: true },
    });
    if (sent) return ignore(deps, row, 'help_already_sent');
  }
  const over = await reserve(deps, row, pro, now);
  if (over) return over;
  await deps.prisma.botMention.update({ where: { id: row.id }, data: { kind: 'help', status: 'QUEUED' } });
  await deps.enqueueReply(row.id);
  return { action: 'help' };
}

async function followUp(
  deps: BotDeps,
  row: Row,
  post: XPost,
  parent: { checkId: string; targetKey: string | null; shortId: string; status: string },
  pro: boolean,
  now: number,
): Promise<MentionOutcome> {
  const bot = botIdentity(deps.env);
  const link = { checkId: parent.checkId, targetKey: parent.targetKey, isFollowUp: true };
  const question = questionText(ownText(post, bot, post.repliedTo), bot);
  if (!question) return ignore(deps, row, 'empty_question', link);
  // the bot's "Couldn't finish this check" has no report to ask about
  if (parent.status !== 'DONE') return ignore(deps, row, 'no_report', link);
  if (!pro) {
    // the pointer goes to the same person at most once per thread
    const sent = await deps.prisma.botMention.findFirst({
      where: {
        id: { not: row.id },
        authorId: row.authorId,
        kind: 'followup',
        status: { in: ['QUEUED', 'REPLIED'] },
        ...(row.conversationId ? { conversationId: row.conversationId } : { checkId: parent.checkId }),
      },
      select: { id: true },
    });
    if (sent) return ignore(deps, row, 'pointer_already_sent', link);
  }
  const over = await reserve(deps, row, pro, now);
  if (over) {
    await deps.prisma.botMention.update({ where: { id: row.id }, data: link }).catch(() => undefined);
    return over;
  }
  await deps.prisma.botMention.update({
    where: { id: row.id },
    // a Pro question is answered by the reply job (model call, Ask); the pointer is fixed text
    data: { ...link, kind: 'followup', status: 'QUEUED', replyText: pro ? null : composePointer(parent.shortId, { includeLink: deps.env.BOT_INCLUDE_LINK, appUrl: deps.env.APP_URL }) },
  });
  await deps.enqueueReply(row.id);
  return { action: 'followup', pro };
}

