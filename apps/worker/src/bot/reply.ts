/**
 * The reply job (queue "bot-replies", one job per BotMention, jobId = mention id). Posts exactly one reply, to the
 * stored mention's own tweet id and nothing else (HANDOFF §11: no reply without a stored BotMention; the bot never
 * mentions anyone unprompted).
 *
 *  - help → HELP_TEXT; check → composeReply() (verdict, or the "Couldn't finish" line for a FAILED check) with the
 *    share card PNG (SCREENSHOT_DIR/cards/<shortId>.png, else WEB_INTERNAL_URL/card/<shortId>.png, else text only);
 *    follow-up → the pointer line stored by handle.ts, or for a Pro author an answer from the check's stored data
 *    (asks/answer.ts answerFromCheck, the same answer site asks get), saved as an Ask (via BOT) with Check.asksCount + 1, once even across retries.
 *  - success → REPLIED, replyTweetId, replyText, repliedAt, and the hourly reply counter. A Redis marker written right
 *    after X accepted the post makes a retry record it instead of posting again when the database update failed.
 *  - Nothing is answered twice: a "posting" marker is written right before the POST. A POST that failed with an
 *    unknown outcome (timeout, 5xx, dropped connection: X may have created the reply and only the answer was lost),
 *    or a process that died mid-POST, leaves it; the next attempt then looks for the bot's reply on X
 *    (XSource.findReply) and records it if it is there, posts only if it is not, and never posts when the lookup
 *    fails. A "duplicate content" refusal right after such an attempt means it did post: REPLIED, not FAILED.
 *  - X did not take the request (429, connection refused) → the job throws and BullMQ retries with backoff
 *    (BOT_REPLY_JOB_OPTIONS, 3 attempts); unknown outcome → the same, looking first; a refusal (4xx), or the last
 *    attempt → FAILED with the reason (in ignoreReason).
 *  - The text may hold no link but the opt-in report link (HANDOFF §11; compose.ts defangs model-written text).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { otherChainOf } from '@apecheck/core';
import { captureErrors } from '@apecheck/sources';
import { answerFromCheck, cleanQuestion } from '../asks/answer';
import { errText } from '../log';
import { webCardFetcher } from '../pipeline/save';
import { pgText } from '../pipeline/pgsafe';
import { FAILED_TEXT, HELP_TEXT, composeFollowUp, composeReply, fitsX, onlyReportLink, reportLink, type ReplyCheck } from './compose';
import { botIdentity, composeOpts, type BotDeps } from './handle';
import { countReplied } from './limits';
import { questionText } from './mention';

export type ReplyOutcome = 'replied' | 'already' | 'skipped' | 'missing' | 'failed';

export interface ReplyAttempt {
  /** BullMQ job.attemptsMade (0 on the first run) */
  attemptsMade: number;
  /** job.opts.attempts */
  attempts: number;
}

/** Thrown to let BullMQ retry the job with backoff. */
export class RetryReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryReplyError';
  }
}

const postedKey = (mentionId: string) => `bot:posted:${mentionId}`;
/**
 * Written right BEFORE the POST ({ text }): a later attempt that finds it (an earlier POST timed out or got a 5xx,
 * or the process died before recording its result) looks for that reply on X before posting again.
 */
export const postingKey = (mentionId: string) => `bot:posting:${mentionId}`;
const MARKER_TTL = 7 * 86400;
/** The text an earlier attempt sent (its posting marker), null when unreadable. */
function postingText(marker: string): string | null {
  try {
    const p = JSON.parse(marker) as { text?: unknown };
    return typeof p?.text === 'string' && p.text ? p.text : null;
  } catch {
    return null;
  }
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CARD_BYTES = 5 * 1024 * 1024; // X's image limit
const isPng = (b: Buffer | null | undefined): b is Buffer => !!b && b.length > 8 && b.length <= MAX_CARD_BYTES && b.subarray(0, 8).equals(PNG_MAGIC);
const SHORT_RE = /^[A-Za-z0-9_-]{4,32}$/;

/** What a failed reply says about whether the post exists on X. */
export type ReplyFailure = 'not_sent' | 'refused' | 'duplicate' | 'unknown';

/**
 * Reading a failed reply's reason (the adapter's lastError):
 *  - not_sent: X did not take the request — 429 / "rate limited" (also the adapter's own back-off, before any
 *    request), or the connection never opened (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, connect timeout, the outbound
 *    proxy refused). Safe to post again;
 *  - refused: X answered 4xx (forbidden, invalid, too long…), or the call was never valid. Posting again gets the
 *    same answer;
 *  - duplicate: X's 403 "duplicate content". On a first attempt a refusal; after an attempt whose outcome was
 *    unknown, the sign that it did post;
 *  - unknown: the request may have reached X and the reply may exist — a timeout, a 5xx, a dropped connection, an
 *    unreadable answer. Never posted again blindly: the next attempt looks for the reply on X first (findReply).
 */
export function replyFailure(reason: string): ReplyFailure {
  // an HTTP status, not a port or an IP address octet ("connect ECONNREFUSED 104.244.42.1:443")
  const status = (re: string) => new RegExp(`(?<![.:\\d])\\b${re}\\b(?![.:]\\d)`).test(reason);
  if (/duplicate/i.test(reason)) return 'duplicate';
  if (status('429') || /rate.?limit|too many requests/i.test(reason)) return 'not_sent';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT|connect ?timeout|proxy refused/i.test(reason)) return 'not_sent';
  if (status('5\\d\\d')) return 'unknown';
  if (status('4\\d\\d') || /forbidden|not allowed|unauthori[sz]ed|invalid|empty text|too long|not configured|not posted/i.test(reason)) return 'refused';
  return 'unknown';
}

/** Worth another attempt (not_sent: post again; unknown: look first, then post only if it is not there). */
export function isRetryable(reason: string): boolean {
  const f = replyFailure(reason);
  return f === 'not_sent' || f === 'unknown';
}

const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * BullMQ backoff for the "x-reply" type (BOT_REPLY_JOB_OPTIONS): 30 s, 60 s, … — or, when X said how long to back
 * off ("rate limited until <ISO time>", the adapter's 429 message), until then plus 2 s, at most 30 minutes.
 */
export function replyBackoff(attemptsMade: number, _type?: string, err?: Error, now = Date.now()): number {
  const base = 30_000 * 2 ** Math.max(0, attemptsMade - 1);
  const until = Date.parse(err?.message.match(/rate limited until (\S+)/)?.[1] ?? '');
  if (Number.isFinite(until)) return Math.min(MAX_BACKOFF_MS, Math.max(base, until - now + 2000));
  return Math.min(MAX_BACKOFF_MS, base);
}

/** The share card: the PNG Stage F saved, else the web's /card route; null when neither works (text-only reply). */
export async function cardPng(deps: Pick<BotDeps, 'env' | 'log' | 'fetchCard'>, check: { shortId: string; cardPath: string | null }): Promise<Buffer | null> {
  if (!SHORT_RE.test(check.shortId)) return null;
  const rel = check.cardPath && /^cards\/[A-Za-z0-9_-]{1,32}\.png$/.test(check.cardPath) ? check.cardPath : `cards/${check.shortId}.png`;
  try {
    const buf = await fs.readFile(path.join(deps.env.SCREENSHOT_DIR, rel));
    if (isPng(buf)) return buf;
  } catch {
    /* not saved (web was down when the check finished, or cleaned up): ask the web */
  }
  try {
    const buf = await (deps.fetchCard ?? webCardFetcher(deps.env.WEB_INTERNAL_URL))(check.shortId);
    if (isPng(buf)) return buf;
  } catch (e) {
    deps.log.info(`share card for ${check.shortId} unavailable: ${errText(e)}`);
  }
  return null;
}

type MentionRow = NonNullable<Awaited<ReturnType<typeof loadMention>>>;

function loadMention(deps: BotDeps, id: string) {
  return deps.prisma.botMention.findUnique({
    where: { id },
    include: {
      check: {
        select: { id: true, shortId: true, status: true, narScore: true, narBand: true, coinScore: true, coinBand: true, summary: true, cardPath: true, evidence: true },
      },
    },
  });
}

async function fail(deps: BotDeps, m: MentionRow, reason: string): Promise<ReplyOutcome> {
  deps.log.warn(`reply to mention ${m.tweetId} failed: ${reason}`);
  await deps.prisma.botMention.updateMany({ where: { id: m.id, status: 'QUEUED' }, data: { status: 'FAILED', ignoreReason: pgText(reason).slice(0, 300) } });
  return 'failed';
}

async function finish(deps: BotDeps, m: MentionRow, replyTweetId: string, text: string): Promise<void> {
  const now = deps.now ? deps.now() : Date.now();
  await deps.prisma.botMention.updateMany({
    where: { id: m.id, status: 'QUEUED' },
    data: { status: 'REPLIED', replyTweetId, replyText: pgText(text), repliedAt: new Date(now) },
  });
  await countReplied(deps.redis, now).catch(e => deps.log.warn('reply counter not updated', e));
  await deps.redis.del(postedKey(m.id), postingKey(m.id)).catch(() => undefined);
  deps.log.info(`replied to mention ${m.tweetId} (${m.kind ?? 'check'}): ${replyTweetId}`);
}

/**
 * X refused a repeat of a post whose earlier attempt had an unknown outcome as a duplicate, and the reply could not be
 * found: that attempt posted it. Recorded as REPLIED without the post id (never FAILED: a reply is live).
 */
async function finishUnconfirmed(deps: BotDeps, m: MentionRow, text: string): Promise<void> {
  const now = deps.now ? deps.now() : Date.now();
  await deps.prisma.botMention.updateMany({
    where: { id: m.id, status: 'QUEUED' },
    data: { status: 'REPLIED', replyText: pgText(text), repliedAt: new Date(now), ignoreReason: 'posted by an earlier attempt (X refused the repeat as a duplicate); post id unknown' },
  });
  await countReplied(deps.redis, now).catch(e => deps.log.warn('reply counter not updated', e));
  await deps.redis.del(postedKey(m.id), postingKey(m.id)).catch(() => undefined);
  deps.log.warn(`mention ${m.tweetId}: replied by an earlier attempt whose post id X never returned`);
}

/** The bot's reply to the mention on X (an earlier attempt's): its id, null when there is none, or why it can't tell. */
async function lookUpReply(deps: BotDeps, m: MentionRow): Promise<{ id: string | null } | { error: string }> {
  if (!deps.x.findReply) return { error: 'the X adapter cannot look up the bot\'s replies' };
  try {
    return { id: await deps.x.findReply(m.tweetId) };
  } catch (e) {
    return { error: errText(e) };
  }
}

/** A Pro follow-up's answer: generated once (with its Ask) and stored as replyText, so a retry posts the same words. */
async function followUpText(deps: BotDeps, m: MentionRow): Promise<string | null> {
  if (m.replyText) return m.replyText;
  if (!m.checkId || !m.check) return null;
  const question = cleanQuestion(questionText(m.text, botIdentity(deps.env)));
  // the same answer the site's asks get (asks/answer.ts): stored data only, made safe, clamped
  const res = await answerFromCheck(deps, m.checkId, question);
  if (!res) return null;
  const text = composeFollowUp(res.answer, m.check.shortId, composeOpts(deps.env));
  const checkId = m.checkId;
  await deps.prisma.$transaction(async tx => {
    const set = await tx.botMention.updateMany({ where: { id: m.id, replyText: null }, data: { replyText: pgText(text) } });
    if (!set.count) return; // an earlier attempt already answered
    await tx.ask.create({
      data: { checkId, question, answer: res.answer, askerHandle: m.authorHandle.replace(/^@+/, '') || null, via: 'BOT' },
    });
    await tx.check.update({ where: { id: checkId }, data: { asksCount: { increment: 1 } } });
  });
  const stored = await deps.prisma.botMention.findUnique({ where: { id: m.id }, select: { replyText: true } });
  return stored?.replyText ?? text;
}

export async function processReply(deps: BotDeps, mentionId: string, attempt: ReplyAttempt = { attemptsMade: 0, attempts: 1 }): Promise<ReplyOutcome> {
  if (typeof mentionId !== 'string' || !mentionId) return 'missing';
  const m = await loadMention(deps, mentionId);
  // HANDOFF §11: nothing is ever posted without a stored mention
  if (!m) {
    deps.log.warn(`reply job for unknown mention ${mentionId}: nothing posted`);
    return 'missing';
  }
  if (m.status === 'REPLIED') return 'already';
  if (m.status !== 'QUEUED') return 'skipped';
  const last = attempt.attemptsMade + 1 >= Math.max(1, attempt.attempts);

  // X accepted a post for this mention but recording it failed: record it now, never post twice
  const marker = await deps.redis.get(postedKey(m.id)).catch(() => null);
  if (marker) {
    try {
      const p = JSON.parse(marker) as { id: string; text: string };
      if (p && typeof p.id === 'string' && typeof p.text === 'string') {
        await finish(deps, m, p.id, p.text);
        return 'replied';
      }
    } catch {
      /* unreadable marker: carry on */
    }
  }

  let text: string | null;
  let png: Buffer | null = null;
  if (m.kind === 'help') {
    text = HELP_TEXT;
  } else if (m.kind === 'followup') {
    text = await followUpText(deps, m);
    if (!text) return fail(deps, m, 'the report has no data to answer from');
  } else {
    if (!m.check) return fail(deps, m, 'no check linked to the mention');
    if (m.check.status === 'QUEUED' || m.check.status === 'RUNNING') {
      // only finished checks are queued for a reply; give a late one a little time, then give up
      if (!last) throw new RetryReplyError('the check is still running');
      return fail(deps, m, 'the check did not finish in time');
    }
    // a coin on a chain ApeCheck can't read: the reply says the coin wasn't checked (and which site the verdict is for)
    const reply: ReplyCheck = { ...m.check, status: m.check.status as ReplyCheck['status'], otherChain: otherChainOf(m.check.evidence) };
    text = composeReply(reply, composeOpts(deps.env));
    if (m.check.status === 'DONE' && text !== FAILED_TEXT) png = await cardPng(deps, m.check);
  }
  if (!fitsX(text)) return fail(deps, m, 'reply text over 280 characters');
  // HANDOFF §11: the only link a reply may hold is the opt-in report link (model-written text is defanged when
  // composed; this also covers a text stored before that)
  const allowedLink = deps.env.BOT_INCLUDE_LINK && m.check ? reportLink(deps.env.APP_URL, m.check.shortId) : null;
  if (!onlyReportLink(text, allowedLink)) return fail(deps, m, 'reply text holds a link other than the report link');
  if (!deps.x.reply || !deps.x.canPost) {
    if (!last) throw new RetryReplyError('X posting is not configured');
    return fail(deps, m, 'X posting is not configured');
  }

  // An earlier attempt sent its POST and never learned the outcome (a timeout or 5xx, or the process died before
  // recording it): X may have created the reply. Look for it before posting again — never post blindly.
  let earlier: string | null;
  try {
    earlier = await deps.redis.get(postingKey(m.id));
  } catch (e) {
    if (!last) throw new RetryReplyError(`could not read the posting marker: ${errText(e)}`);
    return fail(deps, m, `could not tell whether an earlier attempt posted: ${errText(e)}`);
  }
  if (earlier) {
    const found = await lookUpReply(deps, m);
    if ('error' in found) {
      if (!last) throw new RetryReplyError(`looking up an earlier attempt's reply: ${found.error}`);
      return fail(deps, m, `an earlier attempt may have posted the reply; it could not be looked up (${found.error})`);
    }
    if (found.id) {
      deps.log.info(`mention ${m.tweetId}: the earlier attempt did post (${found.id}); recorded, not posted again`);
      await finish(deps, m, found.id, postingText(earlier) ?? text);
      return 'replied';
    }
  }
  // the POST is about to go out: from here on a lost answer means "maybe posted"
  try {
    await deps.redis.set(postingKey(m.id), JSON.stringify({ text }), 'EX', MARKER_TTL);
  } catch (e) {
    if (!last) throw new RetryReplyError(`could not write the posting marker: ${errText(e)}`);
    return fail(deps, m, `not posted: could not write the posting marker (${errText(e)})`);
  }

  let replyId: string | null = null;
  let error: string | null = null;
  try {
    // this call's own errors (lastError is shared by concurrent replies); a failed card upload is not the reason
    // only the asker is replied to: X's auto-filled "Replying to" accounts stored with the mention are left out
    const r = await captureErrors(() => deps.x.reply!(m.tweetId, text, png, { excludeUserIds: m.replyExcludeIds }));
    replyId = r.value;
    error = r.errors.filter(e => !/uploadMedia/.test(e)).at(-1) ?? null;
  } catch (e) {
    error = errText(e);
  }
  if (!replyId) {
    const reason = error ?? deps.x.lastError ?? 'X did not accept the reply';
    const kind = replyFailure(reason);
    if (kind === 'unknown') {
      // the posting marker stays: the next attempt looks for the reply before posting again
      if (!last) throw new RetryReplyError(reason);
      const found = await lookUpReply(deps, m);
      if ('id' in found && found.id) {
        await finish(deps, m, found.id, text);
        return 'replied';
      }
      return fail(deps, m, `X did not confirm the reply (it may have been posted): ${reason}`);
    }
    if (kind === 'duplicate' && earlier) {
      // the repeat of a post whose earlier attempt had an unknown outcome: that attempt posted it
      const found = await lookUpReply(deps, m);
      if ('id' in found && found.id) await finish(deps, m, found.id, postingText(earlier) ?? text);
      else await finishUnconfirmed(deps, m, postingText(earlier) ?? text);
      return 'replied';
    }
    // X did not take it: nothing was posted
    await deps.redis.del(postingKey(m.id)).catch(() => undefined);
    if (!last && kind === 'not_sent') throw new RetryReplyError(reason);
    return fail(deps, m, `X refused the reply: ${reason}`);
  }
  await deps.redis.set(postedKey(m.id), JSON.stringify({ id: replyId, text }), 'EX', MARKER_TTL).catch(() => undefined);
  await finish(deps, m, replyId, text);
  return 'replied';
}
