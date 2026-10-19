/**
 * Fastify app factory. Everything external (env, Prisma, Redis, the shared subscriber, the
 * BullMQ queue) can be injected so tests run against isolated databases; anything not
 * injected is created here and closed with the app.
 */
import { Queue } from 'bullmq';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { QUEUES, getEnv, type CheckJob } from '@apecheck/core';
import { prisma as defaultPrisma } from '@apecheck/db';
import type { AppDeps } from './context';
import { registerCors } from './plugins/cors';
import { registerErrorHandler, registerNotFound } from './plugins/errors';
import { registerRateLimit } from './plugins/rateLimit';
import { registerSession } from './plugins/session';
import { registerShots } from './plugins/shots';
import { ChannelHub, createQueueRedis, createRedis } from './redis';
import { registerCheckRoutes } from './routes/checks';
import { registerEventRoutes } from './routes/events';
import { registerFeedRoutes } from './routes/feed';
import { registerInsightRoutes } from './routes/insights';
import { registerMetaRoutes } from './routes/meta';
import { SseRegistry } from './sse';

export interface BuildOptions extends Partial<AppDeps> {
  logger?: FastifyServerOptions['logger'];
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

  const deps: AppDeps = { env, prisma, redis, hub, queue };

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
  await registerSession(app, env);
  await registerRateLimit(app, redis);
  registerNotFound(app);
  await registerShots(app, env.SCREENSHOT_DIR);

  const streams = new SseRegistry();
  registerMetaRoutes(app, deps);
  registerCheckRoutes(app, deps);
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
