import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { isProd, type Env } from '@apecheck/core';

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** CORS_ORIGINS ∪ {APP_URL}, compared without trailing slashes. */
export function allowedOrigins(env: Env): string[] {
  return [...new Set([...env.CORS_ORIGINS, env.APP_URL].map(trimSlash).filter(Boolean))];
}

/** http://localhost:<port> or http://127.0.0.1:<port> (a local dev server on any port). */
const LOCAL_DEV_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

/**
 * Whether a browser Origin may call the API with credentials. Production is an exact match on
 * CORS_ORIGINS ∪ APP_URL; outside production any local dev origin is accepted too, so a second
 * `next dev` on another port works without editing .env.
 */
export function originAllowed(env: Env, allowed: ReadonlySet<string>, origin: string): boolean {
  const o = trimSlash(origin);
  if (allowed.has(o)) return true;
  return !isProd(env) && LOCAL_DEV_ORIGIN.test(o);
}

export async function registerCors(app: FastifyInstance, env: Env) {
  const allowed = new Set(allowedOrigins(env));
  await app.register(cors, {
    origin: (origin, cb) => {
      // same-origin and non-browser requests carry no Origin header
      if (!origin) return cb(null, true);
      cb(null, originAllowed(env, allowed, origin));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
    exposedHeaders: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'],
    maxAge: 600,
  });
}
