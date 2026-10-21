/**
 * Free X post reads for checks (no key, no X API credits): the two endpoints X's own embed widget uses.
 *  - Syndication (cdn.syndication.twimg.com/tweet-result, as the embed widget and Vercel's react-tweet read it): text,
 *    author, created_at, the parent of a reply (with the parent's own in_reply_to_status_id_str, so the bot walks up a
 *    thread with one read per two posts) and entities.urls with expanded_url (t.co resolved), so the project's
 *    website is found. Tried first.
 *  - oEmbed (publish.twitter.com/oembed, documented by X): author_name, author_url and the post as HTML; links are only
 *    t.co there, so their visible text (the shortened address, "kairo.ai/app…") stands in for them. The fallback.
 * Both are fixed public hosts and every URL is built here from a numeric post id (never a user-supplied URL), so
 * the SSRF guard stays off as for the other fixed APIs; redirects are not followed. Account data (age, followers,
 * bio) is not available this way, and checks no longer read it.
 */
import { z } from 'zod';
import type { Http, XPost, XUser } from '../types';
import { ErrorState, errMsg, uniq } from '../util';

export const X_SYNDICATION_URL = 'https://cdn.syndication.twimg.com/tweet-result';
export const X_OEMBED_URL = 'https://publish.twitter.com/oembed';
export const X_EMBED_HOSTS = ['cdn.syndication.twimg.com', 'publish.twitter.com'] as const;
export const X_EMBED_TIMEOUT_MS = 8_000;
const MAX_BYTES = 1024 * 1024;
const RE_ID = /^\d{1,25}$/;
const RE_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** The token the embed widget sends with tweet-result (react-tweet's getToken). */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export function syndicationUrl(id: string): string {
  return `${X_SYNDICATION_URL}?id=${id}&lang=en&token=${syndicationToken(id)}`;
}

/** oEmbed of the post; `handle` only shapes the post URL (X answers for /i/status/<id> too). */
export function oembedUrl(id: string, handle?: string | null): string {
  const who = handle && RE_HANDLE.test(handle) ? handle : 'i';
  const post = `https://twitter.com/${who}/status/${id}`;
  return `${X_OEMBED_URL}?url=${encodeURIComponent(post)}&omit_script=1&dnt=true`;
}

/* ---------------- syndication ---------------- */

const str = z.string().nullish().catch(null);
const arr = <T extends z.ZodTypeAny>(t: T) =>
  z
    .array(z.unknown())
    .nullish()
    .catch(null)
    .transform(list => (list ?? []).map(x => t.safeParse(x)).filter(r => r.success).map(r => (r as { data: z.infer<T> }).data));

const SynUrlZ = z.object({ url: str, expanded_url: str, display_url: str });
const SynMentionZ = z.object({ screen_name: z.string(), id_str: str });
const SynEntitiesZ = z
  .object({ urls: arr(SynUrlZ), user_mentions: arr(SynMentionZ), symbols: arr(z.object({ text: z.string() })) })
  .partial();
const SynUserZ = z.object({
  id_str: str,
  screen_name: z.string(),
  name: str,
  verified: z.boolean().nullish().catch(null),
  is_blue_verified: z.boolean().nullish().catch(null),
});
interface SynTweet {
  __typename?: string | null;
  id_str: string;
  text: string;
  created_at?: string | null;
  conversation_id_str?: string | null;
  display_text_range?: number[] | null;
  entities?: z.infer<typeof SynEntitiesZ> | null;
  user?: z.infer<typeof SynUserZ> | null;
  in_reply_to_status_id_str?: string | null;
  in_reply_to_user_id_str?: string | null;
  quoted_tweet?: { id_str?: string | null } | null;
  note_tweet?: unknown;
  parent?: SynTweet | null;
}
const SynTweetZ: z.ZodType<SynTweet, unknown> = z.lazy(() =>
  z.object({
    __typename: str,
    id_str: z.string().regex(RE_ID),
    text: z.string(),
    created_at: str,
    conversation_id_str: str,
    display_text_range: z.array(z.number()).nullish().catch(null),
    entities: SynEntitiesZ.nullish().catch(null),
    user: SynUserZ.nullish().catch(null),
    in_reply_to_status_id_str: str,
    in_reply_to_user_id_str: str,
    quoted_tweet: z.object({ id_str: str }).nullish().catch(null),
    note_tweet: z.unknown().optional(),
    // the replied-to post, with its own author and entities (an odd one is dropped, never the post)
    parent: SynTweetZ.nullish().catch(null),
  }),
);

/** Full text of a long post when the payload carries it (note_tweet.note_tweet_results.result.text), else null. */
function noteText(n: unknown): string | null {
  const r = z
    .object({ note_tweet_results: z.object({ result: z.object({ text: z.string() }) }) })
    .safeParse(n);
  return r.success && r.data.note_tweet_results.result.text ? r.data.note_tweet_results.result.text : null;
}

/** UTF-16 index of code point `cp` in `s` (X counts display_text_range in code points). */
function cpIndex(s: string, cp: number): number {
  let i = 0;
  for (let n = 0; n < cp && i < s.length; n++) i += s.codePointAt(i)! > 0xffff ? 2 : 1;
  return i;
}

function embedUser(id: string | null | undefined, handle: string, name: string | null | undefined, verified: boolean | null): XUser {
  // what an embed shows: no account age, followers or bio
  return {
    id: id && RE_ID.test(id) ? id : '',
    handle,
    name: name ?? '',
    createdAt: null,
    followers: null,
    following: null,
    verified,
    description: null,
    url: null,
    bioUrls: [],
    pinnedTweetId: null,
    pinnedText: null,
  };
}

/** The syndication tweet-result as an XPost (parent included as repliedTo when X sent it). */
export function mapSyndication(t: SynTweet, withParent = true): XPost {
  const note = noteText(t.note_tweet);
  const text = note ?? t.text;
  const ents = t.entities ?? {};
  // the post's own photo/video links are not project links
  const ownMedia = new RegExp(`/status/${t.id_str}/(photo|video)/`, 'i');
  const urls = uniq(
    (ents.urls ?? []).map(u => u.expanded_url || null).filter((u): u is string => !!u && /^https?:\/\//i.test(u) && !ownMedia.test(u)),
  );
  const mentions = ents.user_mentions ?? [];
  const u = t.user ?? null;
  const author = u ? embedUser(u.id_str, u.screen_name, u.name, u.verified || u.is_blue_verified ? true : (u.verified ?? null)) : null;
  const r = t.display_text_range;
  const start = r && r.length === 2 ? cpIndex(t.text, Math.max(0, r[0])) : null;
  const post: XPost = {
    id: t.id_str,
    text,
    authorId: author?.id ?? '',
    authorHandle: author?.handle ?? null,
    authorName: author?.name || null,
    createdAt: t.created_at ?? null,
    conversationId: t.conversation_id_str ?? null,
    urls,
    mentions: uniq(mentions.map(m => m.screen_name)),
    mentionUserIds: uniq(mentions.map(m => m.id_str ?? '').filter(id => RE_ID.test(id))),
    cashtags: uniq((ents.symbols ?? []).map(s => s.text.toUpperCase())),
    replyToId: t.in_reply_to_status_id_str && RE_ID.test(t.in_reply_to_status_id_str) ? t.in_reply_to_status_id_str : null,
    quotedId: t.quoted_tweet?.id_str && RE_ID.test(t.quoted_tweet.id_str) ? t.quoted_tweet.id_str : null,
    author,
    displayTextRange:
      start == null ? null : note ? [text.startsWith(t.text.slice(0, start)) ? start : 0, text.length] : [start, Math.max(start, cpIndex(t.text, r![1]))],
    inReplyToUserId: t.in_reply_to_user_id_str && RE_ID.test(t.in_reply_to_user_id_str) ? t.in_reply_to_user_id_str : null,
  };
  if (withParent) post.repliedTo = t.parent && t.parent.id_str === post.replyToId ? mapSyndication(t.parent, false) : null;
  return post;
}

/** null: the post isn't there (deleted, protected, withheld: X answers 404, an empty object or a tombstone). Throws on bad shapes. */
export function parseSyndication(raw: unknown): XPost | null {
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) return null;
  const typename = (raw as { __typename?: unknown }).__typename;
  if (typename === 'TweetTombstone' || (raw as { tombstone?: unknown }).tombstone) return null;
  const r = SynTweetZ.safeParse(raw);
  if (!r.success) throw new Error('unexpected tweet-result shape');
  return mapSyndication(r.data);
}

/* ---------------- oEmbed ---------------- */

const OEmbedZ = z.object({
  url: str,
  author_name: str,
  author_url: str,
  html: z.string(),
});

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const stripTags = (s: string) => decodeEntities(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).trim();

/** The oEmbed answer as an XPost: text from the <p>, the author from author_url, links from the anchors' visible text. */
export function parseOEmbed(raw: unknown, id: string): XPost | null {
  const r = OEmbedZ.safeParse(raw);
  if (!r.success) throw new Error('unexpected oEmbed shape');
  const o = r.data;
  const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(o.html);
  if (!p) return null;
  const inner = p[1];
  const anchors = [...inner.matchAll(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ href: decodeEntities(m[1]), text: stripTags(m[2]) }));
  const urls: string[] = [];
  const mentions: string[] = [];
  const cashtags: string[] = [];
  for (const a of anchors) {
    if (/^@[A-Za-z0-9_]{1,15}$/.test(a.text)) mentions.push(a.text.slice(1));
    else if (/^\$[A-Za-z][A-Za-z0-9_]{0,19}$/.test(a.text)) cashtags.push(a.text.slice(1).toUpperCase());
    else if (/^https?:\/\/t\.co\//i.test(a.href) && !/^pic\.(twitter|x)\.com\//i.test(a.text)) {
      // the visible, shortened address: "kairo.ai" or "kairo.ai/app…"
      const shown = a.text.replace(/…$/, '').trim();
      if (/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(shown)) urls.push(/^https?:\/\//i.test(shown) ? shown : `https://${shown}`);
    }
  }
  const handle = /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?$/i.exec(o.author_url ?? '')?.[1] ?? null;
  // "— Name (@handle) <a …>May 5, 2014</a>" after the </p>
  const tail = o.html.slice(p.index + p[0].length);
  const dateText = [...tail.matchAll(/<a\b[^>]*>([^<]*)<\/a>/gi)].pop()?.[1];
  const date = dateText ? Date.parse(`${decodeEntities(dateText)} UTC`) : NaN;
  const author = handle ? embedUser(null, handle, o.author_name, null) : null;
  return {
    id,
    text: stripTags(inner),
    authorId: '',
    authorHandle: handle,
    authorName: o.author_name || null,
    createdAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
    conversationId: null,
    urls: uniq(urls),
    mentions: uniq(mentions),
    mentionUserIds: [],
    cashtags: uniq(cashtags),
    replyToId: null,
    quotedId: null,
    author,
  };
}

/* ---------------- reader ---------------- */

export class XEmbedReader {
  private readonly errors = new ErrorState('x-embed');
  constructor(private readonly http: Http) {}

  get lastError() {
    return this.errors.lastError;
  }

  /** parsed JSON, or null for 404 / an empty body; throws a readable Error otherwise */
  private async get(url: string): Promise<unknown> {
    const res = await this.http.request(url, { timeoutMs: X_EMBED_TIMEOUT_MS, maxBytes: MAX_BYTES, redirect: false, headers: { accept: 'application/json' } });
    const host = new URL(url).host;
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
    if (res.truncated) throw new Error(`response from ${host} too large`);
    if (!res.text.trim()) return null;
    try {
      return JSON.parse(res.text);
    } catch {
      throw new Error(`bad JSON from ${host}`);
    }
  }

  async syndication(id: string): Promise<XPost | null> {
    return parseSyndication(await this.get(syndicationUrl(id)));
  }

  async oembed(id: string, handle?: string | null): Promise<XPost | null> {
    const raw = await this.get(oembedUrl(id, handle));
    return raw == null ? null : parseOEmbed(raw, id);
  }

  /**
   * The post, read for free: syndication first (expanded links, the parent), oEmbed when syndication fails or has
   * nothing. null when neither has it (deleted, protected, both down); reasons go to lastError. Never throws.
   */
  async getPost(id: string, handle?: string | null): Promise<XPost | null> {
    if (!RE_ID.test(id)) return null;
    let synErr: string | null = null;
    try {
      const post = await this.syndication(id);
      if (post) return post;
    } catch (e) {
      synErr = errMsg(e);
    }
    try {
      const post = await this.oembed(id, handle);
      if (post) return post;
      if (synErr) this.errors.fail('getPost', new Error(`syndication: ${synErr}; oEmbed: no post`));
    } catch (e) {
      this.errors.fail('getPost', new Error(`${synErr ? `syndication: ${synErr}; ` : ''}oEmbed: ${errMsg(e)}`));
    }
    return null;
  }
}

export function createXEmbed(http: Http): XEmbedReader {
  return new XEmbedReader(http);
}
