/**
 * What a mention asks the bot to check (HANDOFF §7 "Resolve what to check, in order"). Pure: no network, no DB.
 *
 *  1. A contract address or a link (project site, X post, chart/explorer link with a contract) the author wrote in
 *     the mention itself: the text inside X's display range, without the bot's handle and X's reply prefix, with
 *     entity URLs already expanded (never t.co). A post the mention quotes counts as a link written in it.
 *  2. Otherwise the post the mention replies to (`replied_to`): the links and contracts in its author's text (its
 *     @handles never count: "Audited by @CertiK" names an auditor, not the project; cashtags never count either: a
 *     ticker names many coins). When it names nothing ("Dex paid." under the project's own "CA: …" post), the posts
 *     above it in the thread (`opts.thread`: its parent, that one's parent, up to three, and the conversation root),
 *     their links and contracts only: the nearest one by the same author (the project's own thread).
 *  3. Otherwise an @handle the author typed in the mention (a project handle; the weakest signal, since people tag
 *     friends next to the bot: it never beats a link or contract of the post they reply under or of its author's
 *     posts above it).
 *  4. Otherwise the nearest link or contract in a post above it by another account (handle.ts prefers the thread's
 *     own check to it), else the author of the post it replies to ("@author" as an X-profile target), or that post
 *     itself when it came without its author.
 *  5. Nothing → help ("Tag me under a project's post, or include its link or contract.").
 *
 * A post the mention replies to that is itself a tag of the bot ("@ApeCheckBot real?") is a request, not a project's
 * post: its author is the person who asked, never a target. What it named is used (its links and contracts, then
 * its @handles after the mention's own), else what it was asked under: the post above it (`opts.above`; when that
 * was not read yet the result is { kind: 'up' } and the caller reads it and resolves again). When the post above names
 * nothing either, the posts above that one decide as in rule 2.
 *
 * The posts above are read by the caller (thread.ts, X's free embed reads only). Until they are (`opts.thread`
 * undefined), a result they could still change (a typed @handle, an author, help) carries `walkUp`: the id of the post
 * that named nothing, to read up from and resolve again.
 *
 * Links to the bot's own posts/profile (also a quote of one of its posts, and any post id in `opts.botPostIds`) and
 * to apecheck.io are never targets.
 *
 * When one post holds several candidates the strongest wins: contract > project site > X post > @handle. A contract
 * names exactly one coin, and the pipeline finds the site and the X account from it; the site is the product itself;
 * an X post is one step removed (the pipeline still has to read it for its links); an @handle is the weakest, since
 * threads tag friends, exchanges and other bots. Within a kind the first one written wins.
 *
 * The result is the raw target string the check gets (fed to detect() like a pasted input) plus why it was chosen.
 */
import { detect, extractRefs, isNonProjectHost, normalizeDomain, X_RESERVED } from '@apecheck/core';
import type { XPost } from '@apecheck/sources';
import { mentionRe, ownText, parentOwnText, tagsBot, type BotIdentity } from './mention';

export type BotTargetType = 'contract' | 'site' | 'xpost' | 'handle';
/**
 * 'thread': a post above the one it replies to by that post's author (the project's own thread); 'above': one by
 * another account.
 */
export type BotTargetFrom = 'mention' | 'replied' | 'thread' | 'above' | 'author';

export type BotResolution =
  | { kind: 'target'; target: string; type: BotTargetType; from: BotTargetFrom; reason: string; walkUp?: string }
  | { kind: 'help'; reason: string; walkUp?: string }
  /** the post the mention replies to is a tag of the bot naming nothing: read post `postId` (above it) and resolve again */
  | { kind: 'up'; postId: string; reason: string };

export interface ResolveOpts {
  /**
   * The post that the replied-to post replies to, read by the caller after a { kind: 'up' } result: undefined when
   * not read yet, null when it could not be read.
   */
  above?: XPost | null;
  /**
   * The posts above the one that named nothing (a result's `walkUp`), nearest first and the conversation root last,
   * read by the caller (thread.ts): undefined when not read yet.
   */
  thread?: readonly XPost[];
  /** ids of posts known to be the bot's own (its stored replies): never a target */
  botPostIds?: ReadonlySet<string>;
}

interface Candidate {
  type: BotTargetType;
  target: string;
}

interface Ctx {
  bot: BotIdentity;
  botPostIds: ReadonlySet<string>;
}

const RANK: Record<BotTargetType, number> = { contract: 0, site: 1, xpost: 2, handle: 3 };
const LABEL: Record<BotTargetType, string> = { contract: 'contract', site: 'project link', xpost: 'X post link', handle: '@handle' };
// t.co links in the text stand for the expanded entity URLs, which are read instead
const RE_TCO = /\bhttps?:\/\/t\.co\/[A-Za-z0-9]+/gi;

const isBot = (h: string | null | undefined, bot: BotIdentity) => !!h && h.replace(/^@+/, '').toLowerCase() === bot.handle.toLowerCase();
const isBotPost = (p: XPost, ctx: Ctx) =>
  isBot(p.authorHandle, ctx.bot) || (!!ctx.bot.userId && p.authorId === ctx.bot.userId) || ctx.botPostIds.has(p.id);
const isStrong = (c: Candidate) => c.type !== 'handle';
const handleOf = (p: XPost) => p.authorHandle?.replace(/^@+/, '').toLowerCase() || null;
const sameAuthor = (a: XPost, b: XPost) => (!!a.authorId && a.authorId === b.authorId) || (!!handleOf(a) && handleOf(a) === handleOf(b));

/** Classify one URL (already expanded). Status ids of the bot's own posts go to `botIds`. */
function fromUrl(url: string, ctx: Ctx, botIds: Set<string>): Candidate | null {
  if (/^https?:\/\/t\.co\//i.test(url)) return null;
  const d = detect(url);
  if (!d || d.kind === 'bad') return null;
  switch (d.kind) {
    case 'evm':
    case 'sol':
    case 'tron':
      return { type: 'contract', target: d.address };
    case 'xpost':
      // the bot's own verdict post or profile is not a project
      if (isBot(d.handle, ctx.bot) || (d.postId && ctx.botPostIds.has(d.postId))) {
        if (d.postId) botIds.add(d.postId);
        return null;
      }
      if (d.postId) return { type: 'xpost', target: `https://x.com/${d.handle ?? 'i'}/status/${d.postId}` };
      return d.handle ? { type: 'handle', target: `https://x.com/${d.handle}` } : null;
    case 'site':
      return isNonProjectHost(d.domain) ? null : { type: 'site', target: d.url };
  }
}

/**
 * Every reference in a post's own text + its expanded URLs, in writing order. `handles: false` leaves the @handles
 * written in it out (a post someone replies under: its handles are other accounts, not its subject).
 */
function candidatesOf(post: Pick<XPost, 'urls' | 'quotedId'>, text: string, ctx: Ctx, handles: boolean): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const botIds = new Set<string>();
  const add = (c: Candidate | null) => {
    if (!c) return;
    const k = `${c.type}:${c.target.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (const u of post.urls ?? []) add(fromUrl(u, ctx, botIds));
  const clean = text.replace(RE_TCO, ' ').replace(mentionRe(ctx.bot.handle, 'gi'), '$1 ');
  const refs = extractRefs(clean);
  for (const u of refs.urls) add(fromUrl(u, ctx, botIds));
  for (const a of refs.evm) add({ type: 'contract', target: a });
  for (const a of refs.sol) add({ type: 'contract', target: a });
  for (const a of refs.tron) add({ type: 'contract', target: a });
  for (const dm of refs.domains) {
    const domain = normalizeDomain(dm);
    if (!isNonProjectHost(domain)) add({ type: 'site', target: `https://${domain}` });
  }
  // a quoted post counts as a link written in the post — unless it is one of the bot's own (a quote of its verdict)
  const quotedId = post.quotedId ?? null;
  if (quotedId && !botIds.has(quotedId) && !ctx.botPostIds.has(quotedId) && !out.some(c => c.type === 'xpost' && c.target.endsWith(`/status/${quotedId}`))) {
    add({ type: 'xpost', target: `https://x.com/i/status/${quotedId}` });
  }
  if (handles) {
    for (const h of refs.handles) {
      if (isBot(h, ctx.bot) || X_RESERVED.has(h.toLowerCase())) continue;
      add({ type: 'handle', target: `https://x.com/${h}` });
    }
  }
  return out;
}

/** The strongest candidate (contract > site > X post > @handle), first written within a kind. */
function best(cands: Candidate[]): Candidate | null {
  let pick: Candidate | null = null;
  for (const c of cands) if (!pick || RANK[c.type] < RANK[pick.type]) pick = c;
  return pick;
}

const target = (c: Candidate, from: BotTargetFrom, reason: string): BotResolution => ({ kind: 'target', target: c.target, type: c.type, from, reason });

/** The author of `p` as an X-profile target, else the post itself (it came without its author). */
function authorOf(p: XPost, reason: string): BotResolution | null {
  const h = p.authorHandle?.replace(/^@+/, '');
  if (h && /^[A-Za-z0-9_]{1,15}$/.test(h) && !X_RESERVED.has(h.toLowerCase())) {
    return { kind: 'target', target: `https://x.com/${h}`, type: 'handle', from: 'author', reason: `author of ${reason}` };
  }
  // no handle came with the post: check the post itself (the pipeline reads its author)
  if (/^\d{1,25}$/.test(p.id)) return { kind: 'target', target: `https://x.com/i/status/${p.id}`, type: 'xpost', from: 'author', reason };
  return null;
}

/** The strongest link or contract of a post above (never its @handles; never a post of the bot). */
function aboveCandidate(p: XPost, ctx: Ctx): Candidate | null {
  return isBotPost(p, ctx) ? null : best(candidatesOf(p, parentOwnText(p), ctx, false));
}

interface Walked {
  /** the nearest post above by the subject's author that names something (its own thread) */
  same: BotResolution | null;
  /** the nearest one by another account */
  other: BotResolution | null;
}

/** What the posts above `subject` (the post that named nothing) name. */
function walked(subject: XPost, ctx: Ctx, opts: ResolveOpts, where: string): Walked {
  const out: Walked = { same: null, other: null };
  for (const p of opts.thread ?? []) {
    if (p.id === subject.id) continue;
    const c = aboveCandidate(p, ctx);
    if (!c) continue;
    if (sameAuthor(p, subject)) out.same ??= target(c, 'thread', `${LABEL[c.type]} in the same author's post above ${where}`);
    else out.other ??= target(c, 'above', `${LABEL[c.type]} in another account's post above ${where}`);
  }
  return out;
}

/** `r`, marked `walkUp` while the posts above `subject` were not read: they could still name what to check. */
function orAbove(r: BotResolution, subject: XPost | null, opts: ResolveOpts): BotResolution {
  if (r.kind === 'up' || !subject?.replyToId || opts.thread !== undefined) return r;
  return { ...r, walkUp: subject.id };
}

/**
 * For the caller's walk up the thread (thread.ts): `p`, a post above `subject`, decides it — by the same author and
 * naming a link or contract, it wins over anything further up.
 */
export function endsThreadWalk(p: XPost, subject: XPost, bot: BotIdentity, botPostIds: ReadonlySet<string> = new Set()): boolean {
  return sameAuthor(p, subject) && !!aboveCandidate(p, { bot, botPostIds });
}

export function resolveBotTarget(mention: XPost, repliedTo: XPost | null | undefined, bot: BotIdentity, opts: ResolveOpts = {}): BotResolution {
  const ctx: Ctx = { bot, botPostIds: opts.botPostIds ?? new Set() };
  // 1. a link or contract the author wrote in the mention (a quoted post counts as a link they wrote)
  const own = ownText(mention, bot, repliedTo);
  const mine = candidatesOf(mention, own, ctx, true);
  const mineStrong = best(mine.filter(isStrong));
  if (mineStrong) return target(mineStrong, 'mention', `${LABEL[mineStrong.type]} in the mention`);
  const myHandle = mine.find(c => c.type === 'handle') ?? null;
  const typedHandle = () => (myHandle ? target(myHandle, 'mention', '@handle in the mention') : null);
  const nothing = (why: string): BotResolution => typedHandle() ?? { kind: 'help', reason: why };

  // the bot's own post (its verdict, its help line) is never what to check
  if (!repliedTo || isBotPost(repliedTo, ctx)) {
    return nothing(repliedTo ? "nothing to check in the mention (it replies to the bot's own post)" : 'nothing to check in the mention');
  }

  const parentText = parentOwnText(repliedTo);
  if (!tagsBot(parentText, bot)) {
    // 2. the links and contracts of the post it replies to, else of its author's posts above it
    const theirs = best(candidatesOf(repliedTo, parentText, ctx, false));
    if (theirs) return target(theirs, 'replied', `${LABEL[theirs.type]} in the post it replies to`);
    const up = walked(repliedTo, ctx, opts, 'the post it replies to');
    if (up.same) return up.same;
    // 3. a typed @handle, 4. another account's post above it, that post's author
    const last = typedHandle() ?? up.other ?? authorOf(repliedTo, 'the post it replies to');
    return orAbove(last ?? { kind: 'help', reason: 'nothing to check in the mention or the post it replies to' }, repliedTo, opts);
  }

  // the post it replies to is itself a tag of the bot: what that tag asked about, never its author
  const tagCands = candidatesOf(repliedTo, parentText, ctx, true);
  const tagStrong = best(tagCands.filter(isStrong));
  if (tagStrong) return target(tagStrong, 'replied', `${LABEL[tagStrong.type]} in the tag it replies to`);
  let above: XPost | null = null;
  if (repliedTo.replyToId) {
    const known = opts.above !== undefined ? opts.above : (repliedTo.repliedTo ?? undefined);
    if (known === undefined) {
      return { kind: 'up', postId: repliedTo.replyToId, reason: 'it replies to a tag of the bot that names nothing: the post that tag replies to decides' };
    }
    // one level up only, and never a post of the bot or another tag of it
    if (known && known.id === repliedTo.replyToId && !isBotPost(known, ctx) && !tagsBot(parentOwnText(known), bot)) above = known;
  }
  const where = 'the post the tag it replies to is under';
  if (above) {
    const aboveStrong = best(candidatesOf(above, parentOwnText(above), ctx, false));
    if (aboveStrong) return target(aboveStrong, 'replied', `${LABEL[aboveStrong.type]} in ${where}`);
  }
  // that post names nothing either: the posts above it, as in rule 2
  const up: Walked = above ? walked(above, ctx, opts, where) : { same: null, other: null };
  if (up.same) return up.same;
  const typed = typedHandle();
  if (typed) return orAbove(typed, above, opts);
  const tagHandle = tagCands.find(c => c.type === 'handle');
  if (tagHandle) return orAbove(target(tagHandle, 'replied', '@handle in the tag it replies to'), above, opts);
  if (up.other) return up.other;
  const a = above ? authorOf(above, where) : null;
  return orAbove(a ?? { kind: 'help', reason: 'it replies to a tag of the bot that names nothing to check' }, above, opts);
}
