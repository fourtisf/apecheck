/**
 * Redis connections for the API process.
 *
 * - `createRedis()` for commands (credits, rate limits, progress reads, locks).
 * - `ChannelHub` wraps ONE subscriber connection per process and fans messages out
 *   to in-process listeners, so a thousand open SSE streams cost one Redis connection.
 */
import { Redis, type RedisOptions } from 'ioredis';

export function createRedis(url: string, opts: RedisOptions = {}): Redis {
  return new Redis(url, {
    // fail commands fast instead of queueing forever when Redis is down
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    ...opts,
  });
}

/**
 * Connection for the BullMQ producer. Only blocking (worker) connections need unlimited retries;
 * the producer fails fast so POST /v1/checks refunds and errors instead of hanging while Redis is away.
 */
export function createQueueRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 3 });
}

export type ChannelListener = (message: string) => void;

export class ChannelHub {
  private readonly listeners = new Map<string, Set<ChannelListener>>();
  /** in-flight SUBSCRIBE per channel; a second listener waits on the same promise */
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly sub: Redis) {
    sub.on('message', (channel: string, message: string) => {
      const set = this.listeners.get(channel);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(message);
        } catch {
          // one broken listener must not starve the others
        }
      }
    });
  }

  /**
   * Add a listener. Resolves once Redis has confirmed the subscription, so callers can
   * read the database afterwards without missing anything published in between.
   * Returns the function that removes the listener.
   */
  async subscribe(channel: string, fn: ChannelListener): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      const p = this.sub.subscribe(channel).finally(() => {
        if (this.pending.get(channel) === p) this.pending.delete(channel);
      });
      this.pending.set(channel, p);
    }
    set.add(fn);
    const pending = this.pending.get(channel);
    if (pending) {
      try {
        await pending;
      } catch (err) {
        set.delete(fn);
        if (set.size === 0 && this.listeners.get(channel) === set) this.listeners.delete(channel);
        throw err;
      }
    }

    let removed = false;
    return async () => {
      if (removed) return;
      removed = true;
      const cur = this.listeners.get(channel);
      if (!cur) return;
      cur.delete(fn);
      if (cur.size === 0) {
        this.listeners.delete(channel);
        try {
          await this.sub.unsubscribe(channel);
        } catch {
          // connection closing; nothing to clean up on the server side
        }
      }
    };
  }

  /** Number of channels with at least one listener (for tests and metrics). */
  get channelCount(): number {
    return this.listeners.size;
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.pending.clear();
    try {
      await this.sub.quit();
    } catch {
      this.sub.disconnect();
    }
  }
}
