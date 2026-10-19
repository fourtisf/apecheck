/**
 * Redis connections for the worker processes.
 *  - bullConnection: BullMQ needs maxRetriesPerRequest null on worker (blocking) connections.
 *  - publisher: plain commands + PUBLISH (step log, progress keys); fails fast instead of queueing forever.
 */
import { Redis } from 'ioredis';

export function bullConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export function publisherConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 2, enableAutoPipelining: true });
}
