/**
 * Frozen feed orders for cursor paging. "Most checked" (Target.checkCount, bumped on every request), "5m volume"
 * (Target.lastVol5m, rewritten by every price tick) and re-checks (a target's row is replaced) all reorder the feed
 * between two page loads, so paging the live order by offset or by key skips rows. The first page therefore stores
 * the order it was cut from (the first SNAPSHOT_MAX target ids) and later pages read their slice of that order.
 *
 * Snapshots are content-addressed (the token is a hash of the query and the ids), so viewers who load the same
 * order share one key. Redis key `feed:snap:<token>` = `<query sig>\n<targetId>,<targetId>,…`, TTL SNAPSHOT_TTL_S.
 */
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/** rows of an order a snapshot keeps (20 pages of 25); past them the feed pages the live order */
export const SNAPSHOT_MAX = 500;
/** how long a paging session keeps the order it started with; after that it pages the live order */
export const SNAPSHOT_TTL_S = 30 * 60;

export const snapshotKey = (token: string) => `feed:snap:${token}`;

const hash = (s: string, len: number) => createHash('sha256').update(s).digest('base64url').slice(0, len);

/** A short signature of the filters that produced an order: a cursor only reads a snapshot of its own query. */
export const querySig = (query: Record<string, unknown>) => hash(JSON.stringify(query), 16);

/** Stores an order and returns its token. */
export async function saveSnapshot(redis: Redis, sig: string, targetIds: string[]): Promise<string> {
  const value = `${sig}\n${targetIds.join(',')}`;
  const token = hash(value, 22);
  await redis.set(snapshotKey(token), value, 'EX', SNAPSHOT_TTL_S);
  return token;
}

/** The stored order, or null when it expired or belongs to another query. */
export async function loadSnapshot(redis: Redis, token: string, sig: string): Promise<string[] | null> {
  const value = await redis.get(snapshotKey(token));
  if (!value) return null;
  const nl = value.indexOf('\n');
  if (nl < 0 || value.slice(0, nl) !== sig) return null;
  const body = value.slice(nl + 1);
  return body ? body.split(',') : [];
}
