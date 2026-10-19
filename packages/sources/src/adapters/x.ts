/**
 * X API v2, app-only Bearer token for reads (posts, accounts). Posting (the bot, M2) needs the four
 * OAuth 1.0a user keys; mentions()/reply() are added in M2.
 */
import { z } from 'zod';
import type { Env } from '@apecheck/core';
import { warnOnce } from '@apecheck/core/node';
import type { Http, XPost, XSource, XUser } from '../types';
import { HttpError } from '../http';
import { ErrorState, uniq } from '../util';

export const X_API = 'https://api.x.com/2';
const TIMEOUT_MS = 10_000;
export const X_USER_FIELDS = 'created_at,public_metrics,verified,description,entities,url,pinned_tweet_id,username,name';
/** note_tweet carries the full text (and entities) of posts longer than 280 characters */
export const X_TWEET_FIELDS = 'created_at,entities,conversation_id,referenced_tweets,author_id,note_tweet';

const UrlEntityZ = z.object({ url: z.string().optional(), expanded_url: z.string().optional(), unwound_url: z.string().optional() });
const EntitiesZ = z
  .object({
    urls: z.array(UrlEntityZ),
    mentions: z.array(z.object({ username: z.string() })),
    cashtags: z.array(z.object({ tag: z.string() })),
  })
  .partial();
const UserZ = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().optional().default(''),
  created_at: z.string().nullish(),
  description: z.string().nullish(),
  verified: z.boolean().nullish(),
  pinned_tweet_id: z.string().nullish(),
  public_metrics: z.object({ followers_count: z.number().nullish(), following_count: z.number().nullish() }).partial().nullish(),
  entities: z
    .object({
      url: z.object({ urls: z.array(UrlEntityZ) }).partial(),
      description: z.object({ urls: z.array(UrlEntityZ) }).partial(),
    })
    .partial()
    .nullish(),
});
const TweetZ = z.object({
  id: z.string(),
  text: z.string(),
  author_id: z.string().optional(),
  created_at: z.string().nullish(),
  conversation_id: z.string().nullish(),
  entities: EntitiesZ.nullish(),
  referenced_tweets: z.array(z.object({ type: z.string(), id: z.string() })).nullish(),
  note_tweet: z.object({ text: z.string(), entities: EntitiesZ.nullish() }).nullish(),
});
const IncludesZ = z
  .object({ users: z.array(z.unknown()), tweets: z.array(z.unknown()) })
  .partial()
  .nullish();
const ErrorsZ = z.array(z.object({ title: z.string().optional(), detail: z.string().optional() })).nullish();
const TweetResponseZ = z.object({ data: TweetZ.nullish(), includes: IncludesZ, errors: ErrorsZ });
const UserResponseZ = z.object({ data: UserZ.nullish(), includes: IncludesZ, errors: ErrorsZ });

type XUserRaw = z.infer<typeof UserZ>;
type XTweetRaw = z.infer<typeof TweetZ>;

const expanded = (u: z.infer<typeof UrlEntityZ>) => u.unwound_url || u.expanded_url || null;

export function mapUser(u: XUserRaw, pinnedText: string | null = null): XUser {
  return {
    id: u.id,
    handle: u.username,
    name: u.name,
    createdAt: u.created_at ?? null,
    followers: u.public_metrics?.followers_count ?? null,
    following: u.public_metrics?.following_count ?? null,
    verified: u.verified ?? null,
    description: u.description ?? null,
    url: (u.entities?.url?.urls ?? []).map(expanded).find(Boolean) ?? null,
    bioUrls: uniq((u.entities?.description?.urls ?? []).map(expanded).filter((x): x is string => !!x)),
    pinnedTweetId: u.pinned_tweet_id ?? null,
    pinnedText,
  };
}

function parseIncludedUsers(list: unknown[] | undefined): XUserRaw[] {
  return (list ?? []).map(u => UserZ.safeParse(u)).filter(r => r.success).map(r => r.data);
}
function parseIncludedTweets(list: unknown[] | undefined): XTweetRaw[] {
  return (list ?? []).map(t => TweetZ.safeParse(t)).filter(r => r.success).map(r => r.data);
}

export function mapPost(t: XTweetRaw, users: XUserRaw[]): XPost {
  const ents = [t.entities, t.note_tweet?.entities].filter((e): e is NonNullable<typeof e> => !!e);
  // the post's own photo/video links are not project links
  const ownMedia = new RegExp(`/status/${t.id}/(photo|video)/`, 'i');
  const urls = uniq(
    ents.flatMap(e => (e.urls ?? []).map(expanded)).filter((u): u is string => !!u && !ownMedia.test(u)),
  );
  const authorRaw = users.find(u => u.id === t.author_id) ?? null;
  const author = authorRaw ? mapUser(authorRaw) : null;
  return {
    id: t.id,
    text: t.note_tweet?.text ?? t.text,
    authorId: t.author_id ?? '',
    authorHandle: author?.handle ?? null,
    authorName: author?.name ?? null,
    createdAt: t.created_at ?? null,
    conversationId: t.conversation_id ?? null,
    urls,
    mentions: uniq(ents.flatMap(e => (e.mentions ?? []).map(m => m.username))),
    cashtags: uniq(ents.flatMap(e => (e.cashtags ?? []).map(c => c.tag.toUpperCase()))),
    replyToId: t.referenced_tweets?.find(r => r.type === 'replied_to')?.id ?? null,
    quotedId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id ?? null,
    author,
  };
}

type XEnv = Pick<Env, 'X_BEARER_TOKEN' | 'X_API_KEY' | 'X_API_SECRET' | 'X_ACCESS_TOKEN' | 'X_ACCESS_SECRET'>;

export class XAdapter implements XSource {
  readonly configured: boolean;
  readonly canPost: boolean;
  private readonly errors = new ErrorState('x');

  constructor(private readonly env: XEnv, private readonly http: Http) {
    this.configured = !!env.X_BEARER_TOKEN;
    this.canPost = !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET);
    if (!this.configured) warnOnce('x', 'X API not configured (X_BEARER_TOKEN empty): post and account lookups are skipped');
  }

  get lastError() {
    return this.errors.lastError;
  }

  /** parsed JSON, or null for 404; throws with a readable reason otherwise */
  private async get(path: string): Promise<unknown> {
    const res = await this.http.request(`${X_API}${path}`, {
      headers: { authorization: `Bearer ${this.env.X_BEARER_TOKEN}`, accept: 'application/json' },
      timeoutMs: TIMEOUT_MS,
    });
    if (res.status === 404) return null;
    if (res.status === 429) {
      const reset = Number(res.headers['x-rate-limit-reset']);
      throw new Error(`rate limited${Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : ''}`);
    }
    if (!res.ok) throw new HttpError(res.status, res.finalUrl, res.text.slice(0, 300), res.headers);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new Error('bad JSON from api.x.com');
    }
  }

  private noData(op: string, errors: z.infer<typeof ErrorsZ>): null {
    const e = errors?.[0];
    if (e) this.errors.fail(op, new Error(e.detail ?? e.title ?? 'no data'));
    return null;
  }

  async getPost(id: string): Promise<XPost | null> {
    if (!this.configured || !/^\d{1,25}$/.test(id)) return null;
    try {
      const raw = await this.get(
        `/tweets/${id}?expansions=author_id,referenced_tweets.id&tweet.fields=${X_TWEET_FIELDS}&user.fields=${X_USER_FIELDS}`,
      );
      if (raw == null) return null;
      const res = TweetResponseZ.parse(raw);
      if (!res.data) return this.noData('getPost', res.errors);
      return mapPost(res.data, parseIncludedUsers(res.includes?.users));
    } catch (e) {
      this.errors.fail('getPost', e);
      return null;
    }
  }

  private async user(op: string, path: string): Promise<XUser | null> {
    try {
      const raw = await this.get(`${path}?user.fields=${X_USER_FIELDS}&expansions=pinned_tweet_id&tweet.fields=created_at,note_tweet`);
      if (raw == null) return null;
      const res = UserResponseZ.parse(raw);
      if (!res.data) return this.noData(op, res.errors);
      const pinned = res.data.pinned_tweet_id
        ? parseIncludedTweets(res.includes?.tweets).find(t => t.id === res.data!.pinned_tweet_id)
        : undefined;
      return mapUser(res.data, pinned ? pinned.note_tweet?.text ?? pinned.text : null);
    } catch (e) {
      this.errors.fail(op, e);
      return null;
    }
  }

  async getUser(handle: string): Promise<XUser | null> {
    const h = handle.trim().replace(/^@/, '');
    if (!this.configured || !/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
    return this.user('getUser', `/users/by/username/${h}`);
  }

  async getUserById(id: string): Promise<XUser | null> {
    if (!this.configured || !/^\d{1,25}$/.test(id)) return null;
    return this.user('getUserById', `/users/${id}`);
  }

  async renameCount(_handle: string): Promise<number | null> {
    warnOnce('x-renames', 'X handle-rename history needs a third-party source (not configured): rename counts are reported as unknown');
    return null;
  }
}

export function createX(env: XEnv, http: Http): XAdapter {
  return new XAdapter(env, http);
}
