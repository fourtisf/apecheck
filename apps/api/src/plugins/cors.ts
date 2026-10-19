import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { Env } from '@apecheck/core';

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** CORS_ORIGINS ∪ {APP_URL}, compared without trailing slashes. */
export function allowedOrigins(env: Env): string[] {
  return [...new Set([...env.CORS_ORIGINS, env.APP_URL].map(trimSlash).filter(Boolean))];
}

export async function registerCors(app: FastifyInstance, env: Env) {
  const allowed = new Set(allowedOrigins(env));
  await app.register(cors, {
    origin: (origin, cb) => {
      // same-origin and non-browser requests carry no Origin header
      if (!origin) return cb(null, true);
      cb(null, allowed.has(trimSlash(origin)));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
    exposedHeaders: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'],
    maxAge: 600,
  });
}
