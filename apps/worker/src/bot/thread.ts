/**
 * The posts above a post that names nothing to check (resolve.ts `walkUp`): "Dex paid." under the project's own
 * "CA: …" post. Read through X's free embed endpoints only (XSource.getPost: syndication, then oEmbed), never the paid
 * X API, so walking a thread costs no X API credits.
 *
 * Nearest first: the post's parent, that one's parent, … up to THREAD_LEVELS posts, then the conversation root when
 * the walk did not reach it. A syndication read carries the read post's own parent (`repliedTo`, with its reply id),
 * which then needs no read of its own: three levels and the root take two or three reads. The walk stops
 *  - at a post `stop()` says decides it (resolve.ts endsThreadWalk: nothing above it could win);
 *  - at the top of the thread (a post that replies to nothing);
 *  - at a post that can't be read (deleted, protected, both embed endpoints down): only the root is still tried;
 *  - when the time budget (all reads together) runs out: what was read until then is used.
 * Never throws.
 */
import type { XPost } from '@apecheck/sources';

/** posts read above the one that named nothing (the conversation root comes on top of these) */
export const THREAD_LEVELS = 3;
/** all the reads of one walk together; a mention is handled while the poll waits */
export const THREAD_BUDGET_MS = 10_000;

const RE_ID = /^\d{1,25}$/;

export interface ThreadOpts {
  /** X's conversation_id: the thread's first post, read last when the walk did not reach it */
  rootId?: string | null;
  /** `p` decides the walk: nothing above it is read */
  stop?: (p: XPost) => boolean;
  levels?: number;
  budgetMs?: number;
}

export async function readThread(read: (id: string) => Promise<XPost | null>, from: XPost, opts: ThreadOpts = {}): Promise<XPost[]> {
  const levels = opts.levels ?? THREAD_LEVELS;
  const deadline = Date.now() + (opts.budgetMs ?? THREAD_BUDGET_MS);
  const rootId = opts.rootId && RE_ID.test(opts.rootId) ? opts.rootId : null;
  // a post read within the time left, else null: a late read ends the walk like a failed one
  const readInTime = async (id: string): Promise<XPost | null> => {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), left);
    });
    try {
      const p = await Promise.race([Promise.resolve().then(() => read(id)).catch(() => null), late]);
      return p && p.id === id ? p : null;
    } finally {
      clearTimeout(timer);
    }
  };

  const out: XPost[] = [];
  const seen = new Set([from.id]);
  let id = from.replyToId && RE_ID.test(from.replyToId) ? from.replyToId : null;
  let carried = from.repliedTo ?? null;
  let top = !id;
  while (id && out.length < levels && !seen.has(id)) {
    seen.add(id);
    const known = carried?.id === id ? carried : null;
    // a carried parent without a reply id of its own that isn't the root: the embed may have left it out, so the post
    // is read for it (its content is still used when that read fails)
    const p = known && (known.replyToId || known.id === rootId) ? known : ((await readInTime(id)) ?? known);
    if (!p) break;
    out.push(p);
    if (opts.stop?.(p)) return out;
    if (!p.replyToId) {
      // the top of the thread — unless it is a carried parent whose own read failed (then the root is still tried)
      top = p !== known || p.id === rootId;
      break;
    }
    carried = p.repliedTo ?? null;
    id = p.replyToId;
  }
  // the conversation root, unless the walk reached it (or it is the post the walk started from)
  if (!top && rootId && !seen.has(rootId)) {
    const root = carried?.id === rootId ? carried : await readInTime(rootId);
    if (root) out.push(root);
  }
  return out;
}
