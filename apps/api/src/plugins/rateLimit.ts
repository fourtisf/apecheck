/**
 * Rate limits on every public endpoint (HANDOFF §11), stored in Redis so they hold across
 * restarts and processes. Global: RATE.globalPerMin per IP; POST /v1/checks has its own,
 * tighter route limit. Screenshots get their own bucket so a report page full of images
 * doesn't eat the API budget.
 */
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

export const RATE = {
  globalPerMin: 120,
  shotsPerMin: 600,
  createCheckPerMin: 10,
} as const;

const isShot = (req: FastifyRequest) => req.url.startsWith('/shots/');

/**
 * Client address for limits and credits. IPv6 is grouped by /64 (one subscriber usually owns
 * the whole prefix), IPv4-mapped IPv6 collapses to IPv4.
 */
export function clientIp(req: FastifyRequest): string {
  return normalizeIP(req.ip || 'unknown');
}

/**
 * Who a request counts against. API keys (M4) will return `key:<apiKeyId>` here so keyed
 * traffic gets per-key limits instead of per-IP ones.
 */
export function rateKey(req: FastifyRequest): string {
  return (isShot(req) ? 'shots:' : 'ip:') + clientIp(req);
}

export async function registerRateLimit(app: FastifyInstance, redis: Redis) {
  await app.register(rateLimit, {
    global: true,
    redis,
    nameSpace: 'rl:',
    timeWindow: '1 minute',
    max: (req: FastifyRequest) => (isShot(req) ? RATE.shotsPerMin : RATE.globalPerMin),
    keyGenerator: rateKey,
    // a Redis hiccup should degrade to "no limit", not take the API down
    skipOnError: true,
    errorResponseBuilder: (_req, ctx) => {
      const err = new Error(`Rate limit exceeded, retry in ${ctx.after}`) as Error & { statusCode: number };
      err.statusCode = ctx.statusCode;
      return err;
    },
  });
}
