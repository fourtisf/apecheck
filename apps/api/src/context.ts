/** What every route needs, injected by buildServer() (tests pass their own). */
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { CheckJob, Env } from '@apecheck/core';
import type { PrismaClient } from '@apecheck/db';
import type { ChannelHub } from './redis';

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  /** commands: credits, rate limits, progress, locks */
  redis: Redis;
  /** the one shared pub/sub subscriber of this process */
  hub: ChannelHub;
  /** BullMQ producer for queue "checks" */
  queue: Queue<CheckJob>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** anonymous session id from the signed SID cookie (always set by the session hook) */
    sid: string;
    /** the session hook minted this sid on this request (cookie is being set) */
    sidIsNew: boolean;
  }
}
