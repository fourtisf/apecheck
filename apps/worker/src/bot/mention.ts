/**
 * What a mention says, as opposed to what X put around it. Pure functions.
 *
 * A reply's text starts with the thread's @handles, which X adds by itself ("auto-populated reply metadata"); on
 * X they show as "Replying to @a @b", not in the post. Only what the author typed — X's display_text_range,
 * `XPost.displayTextRange` from mentions() — counts as asking the bot something. When X sent no range, the
 * leading @handles that X would have added (the replied-to post's author and the handles in it) are taken off.
 */
import type { XPost } from '@apecheck/sources';

export interface BotIdentity {
  /** without "@" */
  handle: string;
  userId: string | null;
}

/** X treats the full-width at sign like "@". */
const AT = '[@＠]';
const RE_LEADING_MENTION = new RegExp(`^\\s*${AT}([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])`);

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();
const sameHandle = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && lower(a) === lower(b);

/** "@x" mentions of `handle` in `text` (case-insensitive, both at signs). */
export function mentionRe(handle: string, flags = 'i'): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_@＠])${AT}${handle.replace(/[^A-Za-z0-9_]/g, '')}(?![A-Za-z0-9_])`, flags);
}

/**
 * Leading @handles X added to a reply. `context` is who X carries over into the reply (the replied-to post's
 * author and its @mentions), lowercase; null when unknown. Known context: the run of leading mentions that are
 * all in it. Unknown: the leading run up to the bot's own handle (a "@bot ..." the author typed first is theirs).
 */
function autoPrefixEnd(text: string, context: Set<string> | null, bot: BotIdentity): number {
  let end = 0;
  for (;;) {
    const m = text.slice(end).match(RE_LEADING_MENTION);
    if (!m) break;
    const h = m[1].toLowerCase();
    if (context ? !context.has(h) : sameHandle(h, bot.handle)) break;
    end += m[0].length;
  }
  return end;
}

/** Who X carries over into a reply to `parent`: its author and the handles it mentions. */
export function replyContext(parent: XPost | null | undefined): Set<string> | null {
  if (!parent) return null;
  const set = new Set<string>();
  if (parent.authorHandle) set.add(parent.authorHandle.toLowerCase());
  for (const h of parent.mentions ?? []) set.add(h.replace(/^@+/, '').toLowerCase());
  return set;
}

/**
 * The text the author typed: `displayTextRange` when X sent one (JS string indices into `text`), else the text
 * without X's reply prefix (a post that is not a reply has none). Trimmed.
 */
export function ownText(post: Pick<XPost, 'text' | 'replyToId' | 'displayTextRange'>, bot: BotIdentity, parent?: XPost | null): string {
  const text = post.text ?? '';
  const r = post.displayTextRange;
  if (Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[0] <= r[1]) {
    return text.slice(r[0], Math.min(r[1], text.length)).trim();
  }
  if (!post.replyToId) return text.trim();
  return text.slice(autoPrefixEnd(text, replyContext(parent), bot)).trim();
}

/**
 * The text a post's author typed when it is someone else's post (the one a mention replies to): its display range,
 * else every leading @handle of a reply is taken as X's prefix (what matters there is links, contracts and handles
 * the author wrote, not the thread's).
 */
export function parentOwnText(post: XPost): string {
  const text = post.text ?? '';
  const r = post.displayTextRange;
  if (Array.isArray(r) && r.length === 2 && r[0] >= 0 && r[0] <= r[1]) return text.slice(r[0], Math.min(r[1], text.length)).trim();
  if (!post.replyToId) return text.trim();
  let end = 0;
  for (;;) {
    const m = text.slice(end).match(RE_LEADING_MENTION);
    if (!m) break;
    end += m[0].length;
  }
  return text.slice(end).trim();
}

/** The author typed the bot's handle (not just X's reply prefix). */
export function tagsBot(own: string, bot: BotIdentity): boolean {
  return mentionRe(bot.handle).test(own);
}

/** The bot's own posts never trigger anything. */
export function isFromBot(post: Pick<XPost, 'authorId' | 'authorHandle'>, bot: BotIdentity): boolean {
  return (!!bot.userId && post.authorId === bot.userId) || sameHandle(post.authorHandle, bot.handle);
}

/** A retweet ("RT @user: …"): someone else's words passed on, never a request. */
export function isRetweet(post: Pick<XPost, 'text'>): boolean {
  return new RegExp(`^RT ${AT}[A-Za-z0-9_]{1,15}:`).test(post.text ?? '');
}

/** The question in a follow-up: the author's own text without the bot's handle, whitespace collapsed. */
export function questionText(own: string, bot: BotIdentity): string {
  return own.replace(mentionRe(bot.handle, 'gi'), '$1').replace(/\s+/g, ' ').trim();
}

/** Ids kept on a BotMention: more than the adapter sends (X_REPLY_EXCLUDE_MAX), so a cut never sends a partial list. */
const MAX_EXCLUDE_IDS = 500;

/**
 * Who X would put in the bot's reply besides the asker (HANDOFF §7: never mention anyone unprompted). A v2 reply
 * "Replies to" the post's author and every account the post @mentions, X's own reply prefix included; all of them
 * but the asker (X keeps the leading @mention, and leaving it out breaks the reply) go to reply.exclude_reply_user_ids.
 * The bot's own id is left out too. Numeric ids only, once each.
 */
export function replyExcludeIds(post: Pick<XPost, 'authorId' | 'mentionUserIds' | 'inReplyToUserId'>, bot: BotIdentity): string[] {
  const ids = [...(post.mentionUserIds ?? []), post.inReplyToUserId];
  const out = ids.filter((id): id is string => typeof id === 'string' && /^\d{1,25}$/.test(id) && id !== post.authorId && id !== bot.userId);
  return [...new Set(out)].slice(0, MAX_EXCLUDE_IDS);
}

/** X post ids are snowflakes: compare as numbers (a longer id is newer). */
export function compareIds(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  }
}
