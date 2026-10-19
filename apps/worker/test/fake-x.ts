/**
 * FakeX: the XSource contract (packages/sources/src/types.ts) with the M2 bot methods, in memory. Mentions are
 * served from `inbox` (newer than since_id, oldest first, like the adapter); replies are recorded with their media.
 */
import type { XPost, XReplyOptions, XSource, XUser } from '@apecheck/sources';
import { xUser } from './fakes';

export interface PostedReply {
  id: string;
  inReplyToId: string;
  text: string;
  media: Buffer | null;
  /** XReplyOptions.excludeUserIds, recorded only when non-empty */
  excludeUserIds?: string[];
}

export class FakeX implements XSource {
  configured = true;
  canPost = true;
  lastError: string | null = null;
  /** every mention X would return (filtered by since_id on each call) */
  inbox: XPost[] = [];
  posts = new Map<string, XPost>();
  users = new Map<string, XUser>();
  replies: PostedReply[] = [];
  mentionCalls: (string | null)[] = [];
  /** the next reply() calls fail with these reasons (lastError), in order */
  failReplies: string[] = [];
  /**
   * the next reply() calls POST the reply (X creates it) but the answer is lost: they fail with these reasons
   * (a timeout, a 5xx), in order — after failReplies
   */
  lostReplies: string[] = [];
  /** findReply() calls (the replied-to ids); `findFails` makes the next ones throw with these reasons */
  findCalls: string[] = [];
  findFails: string[] = [];
  private seq = 9_100_000_000_000_000_000n;

  async getPost(id: string) {
    return this.posts.get(id) ?? null;
  }
  async getUser(handle: string) {
    return [...this.users.values()].find(u => u.handle.toLowerCase() === handle.toLowerCase()) ?? null;
  }
  async getUserById(id: string) {
    return this.users.get(id) ?? null;
  }
  async renameCount() {
    return null;
  }
  async mentions(sinceId: string | null) {
    this.mentionCalls.push(sinceId);
    const posts = this.inbox
      .filter(p => !sinceId || BigInt(p.id) > BigInt(sinceId))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return { posts, newestId: posts.length ? posts[posts.length - 1].id : null };
  }
  async reply(inReplyToId: string, text: string, mediaPng?: Buffer | null, opts?: XReplyOptions) {
    const fail = this.failReplies.shift();
    if (fail) {
      this.lastError = fail;
      return null;
    }
    this.lastError = null;
    const id = String(++this.seq);
    const exclude = opts?.excludeUserIds?.length ? { excludeUserIds: [...opts.excludeUserIds] } : {};
    this.replies.push({ id, inReplyToId, text, media: mediaPng ?? null, ...exclude });
    const lost = this.lostReplies.shift();
    if (lost) {
      this.lastError = lost;
      return null;
    }
    return id;
  }
  async findReply(inReplyToId: string) {
    this.findCalls.push(inReplyToId);
    const fail = this.findFails.shift();
    if (fail) throw new Error(fail);
    return this.replies.find(r => r.inReplyToId === inReplyToId)?.id ?? null;
  }
}

const DAY = 86_400_000;
let nextId = 1_850_000_000_000_000_000n;
/** A fresh, increasing tweet id. */
export const tweetId = () => String(++nextId);

/** An X post as the adapter maps it; `displayTextRange` defaults to the whole text. */
export function post(p: Partial<XPost> & { text: string }): XPost {
  const id = p.id ?? tweetId();
  const handle = p.authorHandle ?? 'degen_rina';
  const authorId = p.authorId ?? '501';
  return {
    id,
    authorId,
    authorHandle: handle,
    authorName: handle,
    createdAt: new Date().toISOString(),
    conversationId: p.conversationId ?? id,
    urls: [],
    mentions: [...p.text.matchAll(/@([A-Za-z0-9_]{1,15})/g)].map(m => m[1]),
    cashtags: [],
    replyToId: null,
    quotedId: null,
    author: xUser({ handle, id: authorId, createdAt: new Date(Date.now() - 400 * DAY).toISOString() }),
    displayTextRange: [0, p.text.length],
    inReplyToUserId: null,
    repliedTo: null,
    ...p,
  };
}

/**
 * A reply to `parent` the way X delivers it: X's prefix ("@parentAuthor ") before what the author typed, and the
 * display range starting after it.
 */
export function replyTo(parent: XPost, typed: string, p: Partial<XPost> = {}): XPost {
  const prefixHandles = [parent.authorHandle, ...parent.mentions].filter((h, i, a): h is string => !!h && a.indexOf(h) === i && h !== (p.authorHandle ?? 'degen_rina'));
  const prefix = prefixHandles.map(h => `@${h} `).join('');
  const text = prefix + typed;
  return post({
    text,
    replyToId: parent.id,
    conversationId: parent.conversationId ?? parent.id,
    inReplyToUserId: parent.authorId,
    repliedTo: parent,
    displayTextRange: [prefix.length, text.length],
    ...p,
  });
}
