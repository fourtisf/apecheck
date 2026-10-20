/** What every route needs, injected by buildServer() (tests pass their own). */
import type { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AskJob, AskJobResult, CheckJob, Env, RecheckJob, WebhookJob } from '@apecheck/core';
import type { PrismaClient, User } from '@apecheck/db';
import type { DexScreenerSource, EvmWalletSource, Http, SolanaWalletSource, SsrfOptions } from '@apecheck/sources';
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
  /** M4: DNS for the webhook URL check (SSRF guard); unset = the system resolver. Tests pass a fake. */
  lookup?: SsrfOptions['lookup'];
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
  /** M4: BullMQ producer for queue "webhooks" (the test ping; the worker queues the events) */
  webhooks?: Queue<WebhookJob>;
  /** M4: how long the MCP tool run_check waits for a check to finish (default MCP_RUN_WAIT_MS, 150 s) */
  mcpWaitMs?: number;
}

/** Who is asking: the anonymous cookie id, and the signed-in user when the session cookie holds a live session. */
export interface RequestViewer {
  sid: string;
  /** the Redis session id (SESSION_COOKIE), null when signed out */
  sessionId: string | null;
  user: User | null;
  /**
   * M4: the API key this request authenticated with ("Authorization: Bearer ak_live_…"), else null. `user` is then the
   * key's owner (a Max user) and there is no session.
   */
  apiKeyId?: string | null;
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
