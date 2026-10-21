/**
 * readThread() (bot/thread.ts): the posts above a post that names nothing, read through a getPost stand-in. Pure: no
 * DB, no network.
 */
import { describe, expect, it } from 'vitest';
import type { XPost } from '@apecheck/sources';
import { THREAD_LEVELS, readThread } from '../src/bot/thread';
import { post } from './fake-x';

/** A thread of `n` posts, the first at the top: each one replies to the one before; all in its conversation. */
function chain(n: number): XPost[] {
  const out: XPost[] = [];
  for (let i = 0; i < n; i++) {
    const above = out[i - 1];
    out.push(post({ text: `${i + 1}/`, replyToId: above?.id ?? null, conversationId: out[0]?.id }));
  }
  return out;
}

/** What X's syndication read gives: the post with its parent attached (the parent without its own parent). */
const withParent = (p: XPost, byId: Map<string, XPost>): XPost => {
  const parent = p.replyToId ? byId.get(p.replyToId) : undefined;
  return { ...p, repliedTo: parent ? { ...parent, repliedTo: undefined } : null };
};

function reader(posts: XPost[], o: { fail?: string[]; hang?: string[]; syndication?: boolean } = {}) {
  const byId = new Map(posts.map(p => [p.id, p]));
  const calls: string[] = [];
  const read = async (id: string): Promise<XPost | null> => {
    calls.push(id);
    if (o.hang?.includes(id)) return new Promise<XPost | null>(() => undefined);
    if (o.fail?.includes(id)) throw new Error('HTTP 503 from cdn.syndication.twimg.com');
    const p = byId.get(id);
    return p ? (o.syndication ? withParent(p, byId) : p) : null;
  };
  return { read, calls };
}

const ids = (posts: XPost[]) => posts.map(p => p.text);

describe('readThread', () => {
  it('nearest first, up to three posts, then the conversation root', async () => {
    const t = chain(7);
    const r = reader(t);
    expect(THREAD_LEVELS).toBe(3);
    expect(ids(await readThread(r.read, t[6], { rootId: t[0].id }))).toEqual(['6/', '5/', '4/', '1/']);
    expect(r.calls).toEqual([t[5].id, t[4].id, t[3].id, t[0].id]);
  });

  it('a parent the read carried (syndication `parent`) is used without reading it again', async () => {
    const t = chain(7);
    const r = reader(t, { syndication: true });
    const from = withParent(t[6], new Map(t.map(p => [p.id, p])));
    expect(ids(await readThread(r.read, from, { rootId: t[0].id }))).toEqual(['6/', '5/', '4/', '1/']);
    // 6/ came with the post it started from, 4/ with the read of 5/; only 5/ and the root were read
    expect(r.calls).toEqual([t[4].id, t[0].id]);
  });

  it('the root carried by the last read is not read again; the top of the thread ends the walk', async () => {
    const t = chain(5);
    const r = reader(t, { syndication: true });
    expect(ids(await readThread(r.read, t[4], { rootId: t[0].id }))).toEqual(['4/', '3/', '2/', '1/']);
    expect(r.calls).toEqual([t[3].id, t[1].id]);
    const short = chain(3);
    const s = reader(short);
    expect(ids(await readThread(s.read, short[2], { rootId: short[0].id }))).toEqual(['2/', '1/']);
    expect(s.calls).toEqual([short[1].id, short[0].id]); // the root once, as the top
  });

  it('stop(): nothing above the post that decides the walk is read', async () => {
    const t = chain(6);
    const r = reader(t);
    expect(ids(await readThread(r.read, t[5], { rootId: t[0].id, stop: p => p.text === '4/' }))).toEqual(['5/', '4/']);
    expect(r.calls).toEqual([t[4].id, t[3].id]);
  });

  it('a post that cannot be read (deleted, a failed read) ends the walk; the root is still tried', async () => {
    const t = chain(6);
    const failed = reader(t, { fail: [t[3].id] });
    expect(ids(await readThread(failed.read, t[5], { rootId: t[0].id }))).toEqual(['5/', '1/']);
    expect(failed.calls).toEqual([t[4].id, t[3].id, t[0].id]);
    const deleted = reader(t.filter(p => p !== t[4]));
    expect(ids(await readThread(deleted.read, t[5], { rootId: t[0].id }))).toEqual(['1/']);
    // a read that answers with another post counts as unreadable
    const wrong = await readThread(async () => t[1], t[5], { rootId: null });
    expect(wrong).toEqual([]);
  });

  it('a read that never answers: the time budget ends the walk with what was read, and nothing more is read', async () => {
    const t = chain(6);
    const r = reader(t, { hang: [t[3].id] });
    const started = Date.now();
    expect(ids(await readThread(r.read, t[5], { rootId: t[0].id, budgetMs: 80 }))).toEqual(['5/']);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.calls).toEqual([t[4].id, t[3].id]); // the root is not even asked for: no time left
  });

  it("a carried parent without a reply id that isn't the root is read for its own (the embed left it out)", async () => {
    const t = chain(5);
    const r = reader(t);
    const from = { ...t[4], repliedTo: { ...t[3], replyToId: null } };
    expect(ids(await readThread(r.read, from, { rootId: t[0].id }))).toEqual(['4/', '3/', '2/', '1/']);
    expect(r.calls[0]).toBe(t[3].id);
    // that read failing: its content is still used, and the root tried
    const f = reader(t, { fail: [t[3].id] });
    expect(ids(await readThread(f.read, from, { rootId: t[0].id }))).toEqual(['4/', '1/']);
  });

  it('nothing above a post at the top: no read', async () => {
    const t = chain(1);
    const r = reader(t);
    expect(await readThread(r.read, t[0], { rootId: t[0].id })).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});
