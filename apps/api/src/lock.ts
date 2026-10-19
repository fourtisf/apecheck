/** Short Redis mutex so a double-submitted check for the same target creates one check, not two. */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Run `fn` holding `key`. If the lock can't be taken within `waitMs` (a stuck holder),
 * `fn` runs anyway: the lock only narrows a race, it never blocks a check.
 */
export async function withLock<T>(redis: Redis, key: string, fn: () => Promise<T>, opts: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const ttlMs = opts.ttlMs ?? 10_000;
  const deadline = Date.now() + (opts.waitMs ?? 3_000);
  const token = randomBytes(12).toString('hex');
  let held = false;
  try {
    for (;;) {
      held = (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
      if (held || Date.now() >= deadline) break;
      await sleep(40);
    }
  } catch {
    held = false;
  }
  try {
    return await fn();
  } finally {
    if (held) await redis.eval(RELEASE_LUA, 1, key, token).catch(() => undefined);
  }
}
