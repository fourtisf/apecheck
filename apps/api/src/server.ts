/**
 * Fastify app factory. Everything external (env, Prisma, Redis, the shared subscriber, the
 * BullMQ queues, the data sources) can be injected so tests run against isolated databases and
 * fakes; anything not injected is created here and closed with the app.
 */
import { Queue } from 'bullmq';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { QUEUES, getEnv, type CheckJob, type RecheckJob } from '@apecheck/core';
import { prisma as defaultPrisma } from '@apecheck/db';
import { createDexScreener, createEvm, createHttp, createSolana } from '@apecheck/sources';
import { createAskBroker } from './asks';
import type { ApiSources, AppDeps } from './context';
import { registerCors } from './plugins/cors';
import { registerErrorHandler, registerNotFound } from './plugins/errors';
import { registerRateLimit } from './plugins/rateLimit';
import { registerSession } from './plugins/session';
import { registerShots } from './plugins/shots';
import { ChannelHub, createQueueRedis, createRedis } from './redis';
import { registerAuthRoutes } from './routes/auth';
import { registerCheckRoutes } from './routes/checks';
import { registerCommunityRoutes } from './routes/community';
import { registerEventRoutes } from './routes/events';
import { registerFeedRoutes } from './routes/feed';
import { registerInsightRoutes } from './routes/insights';
import { registerMetaRoutes } from './routes/meta';
import { registerWatchRoutes } from './routes/watch';
import { SseRegistry } from './sse';

export interface BuildOptions extends Partial<AppDeps> {
  logger?: FastifyServerOptions['logger'];
}

/** The @apecheck/sources adapters the API reads (token balances, EIP-1271, the $APECHECK quote, X OAuth). */
export function createApiSources(env: AppDeps['env']): ApiSources {
  const http = createHttp(env);
  return { http, dex: createDexScreener(env, http), evm: createEvm(env, http), sol: createSolana(env, http) };
}

export async function buildServer(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? getEnv();
  const owned: (() => Promise<unknown>)[] = [];

  const prisma = opts.prisma ?? defaultPrisma;
  if (!opts.prisma) owned.push(() => prisma.$disconnect());

  const redis = opts.redis ?? createRedis(env.REDIS_URL);
  if (!opts.redis) owned.push(() => redis.quit());

  const hub = opts.hub ?? new ChannelHub(createRedis(env.REDIS_URL, { maxRetriesPerRequest: null }));
  if (!opts.hub) owned.push(() => hub.close());

  let queue = opts.queue;
  if (!queue) {
    const conn = createQueueRedis(env.REDIS_URL);
    const q = new Queue<CheckJob>(QUEUES.checks, { connection: conn });
    queue = q;
    owned.push(async () => {
      await q.close();
      await conn.quit();
    });
  }

  let rechecks = opts.rechecks;
  if (!rechecks) {
    const conn = createQueueRedis(env.REDIS_URL);
    const q = new Queue<RecheckJob>(QUEUES.rechecks, { connection: conn });
    rechecks = q;
    owned.push(async () => {
      await q.close();
      await conn.quit();
    });
  }

  const sources = opts.sources ?? createApiSources(env);

  const asks = opts.asks ?? createAskBroker(env);
  if (!opts.asks) owned.push(() => asks.close());

  const deps: AppDeps = { env, prisma, redis, hub, queue, rechecks, sources, asks };

  const app = Fastify({
    logger: opts.logger ?? { level: env.LOG_LEVEL },
    // Only the local reverse proxy (Nginx on the same box) is trusted for X-Forwarded-For.
    // Trusting every hop would let a client pick its own IP and dodge per-IP credits and limits.
    trustProxy: 'loopback',
    bodyLimit: 32 * 1024,
    return503OnClosing: true,
  });

  registerErrorHandler(app);
  await registerCors(app, env);
  await registerSession(app, deps);
  await registerRateLimit(app, redis);
  registerNotFound(app);
  await registerShots(app, env.SCREENSHOT_DIR);

  const streams = new SseRegistry();
  registerMetaRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerCheckRoutes(app, deps);
  registerCommunityRoutes(app, deps);
  registerWatchRoutes(app, deps);
  registerEventRoutes(app, deps, streams);
  registerFeedRoutes(app, deps);
  registerInsightRoutes(app, deps);

  // open SSE streams would hold server.close() forever
  app.addHook('preClose', async () => streams.endAll());
  app.addHook('onClose', async () => {
    for (const close of owned) await close().catch(() => undefined);
  });

  return app;
}
