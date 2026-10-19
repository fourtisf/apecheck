/** What every route needs, injected by buildServer() (tests pass their own). */
import type { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AskJob, AskJobResult, CheckJob, Env, RecheckJob } from '@apecheck/core';
import type { PrismaClient, User } from '@apecheck/db';
import type { DexScreenerSource, EvmWalletSource, Http, SolanaWalletSource } from '@apecheck/sources';
import type { ChannelHub } from './redis';

/**
 * The outside data the API reads itself (M3): token balances for tiers, EIP-1271 for smart-wallet sign-in, the
 * $APECHECK quote, and X OAuth over `http`. buildServer() wires the @apecheck/sources adapters; tests pass fakes.
 */
export interface ApiSources {
  http: Http;
  dex: Pick<DexScreenerSource, 'token'>;
  evm: Pick<EvmWalletSource, 'tokenBalance' | 'isValidSignature'>;
  sol: Pick<SolanaWalletSource, 'tokenBalance'>;
}

/** Follow-up questions (M3): the producer for queue "asks" and the process's one QueueEvents listener. */
export interface AskBroker {
  queue(): Queue<AskJob, AskJobResult>;
  /** created on first use, shared by every waiting request */
  events(): Promise<QueueEvents>;
  /** how long POST /v1/checks/:id/asks waits for the worker's answer (45 s) */
  waitMs: number;
  close(): Promise<void>;
}

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  /** commands: credits, rate limits, progress, locks, sessions */
  redis: Redis;
  /** the one shared pub/sub subscriber of this process */
  hub: ChannelHub;
  /** BullMQ producer for queue "checks" */
  queue: Queue<CheckJob>;
  /** M3: BullMQ producer for queue "rechecks" (the first fingerprint of a target a Pro/Max user starts watching) */
  rechecks?: Queue<RecheckJob>;
  sources: ApiSources;
  asks: AskBroker;
}

/** Who is asking: the anonymous cookie id, and the signed-in user when the session cookie holds a live session. */
export interface RequestViewer {
  sid: string;
  /** the Redis session id (SESSION_COOKIE), null when signed out */
  sessionId: string | null;
  user: User | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** anonymous session id from the signed SID cookie (always set by the session hook) */
    sid: string;
    /** the session hook minted this sid on this request (cookie is being set) */
    sidIsNew: boolean;
    /** M3: resolved by the session plugin's preHandler hook on every route */
    viewer: RequestViewer;
  }
}
