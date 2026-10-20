/**
 * Sessions.
 *
 * Anonymous: every visitor gets a random 24-byte id in a signed, httpOnly cookie (SID_COOKIE). It keys credits and
 * the "You" badges (Check.requesterSid).
 *
 * Signed in (M3): wallet sign-in creates a random 32-byte session id, stored in Redis (sessionKey → {userId}) for
 * SESSION_DAYS and carried in the signed, httpOnly SESSION_COOKIE (SameSite=Lax, Secure in production). Both cookies
 * take COOKIE_DOMAIN when it is set (".apecheck.io"), so the web server sees them too. A preHandler hook resolves
 * `request.viewer` ({ sid, sessionId, user }) on every route; a missing or expired session is simply signed out.
 */
import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { SESSION_COOKIE, SESSION_DAYS, SID_COOKIE, isProd, sessionKey, type Env } from '@apecheck/core';
import type { PrismaClient } from '@apecheck/db';
import { ApiError } from '../errors';
import { hasBearer } from './apiKeys';
import { originAllowed, allowedOrigins } from './cors';

const SID_RE = /^[A-Za-z0-9_-]{32}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
const ONE_YEAR_S = 365 * 24 * 3600;
export const SESSION_TTL_S = SESSION_DAYS * 24 * 3600;
/** User.lastSeenAt is written at most this often per user */
const SEEN_EVERY_MS = 10 * 60_000;

export const newSid = () => randomBytes(24).toString('base64url');
export const newSessionId = () => randomBytes(32).toString('base64url');

const skipSession = (request: FastifyRequest) =>
  request.method === 'OPTIONS' || request.url.startsWith('/shots/') || request.url === '/health';

export function sidCookieOptions(env: Env) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProd(env),
    path: '/',
    maxAge: ONE_YEAR_S,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function sessionCookieOptions(env: Env) {
  return { ...sidCookieOptions(env), maxAge: SESSION_TTL_S };
}

/* ---------------- session store ---------------- */

interface StoredSession {
  userId: string;
  createdAt: string;
}

export async function createSession(redis: Redis, userId: string): Promise<string> {
  const id = newSessionId();
  const value: StoredSession = { userId, createdAt: new Date().toISOString() };
  await redis.set(sessionKey(id), JSON.stringify(value), 'EX', SESSION_TTL_S);
  return id;
}

export async function readSession(redis: Redis, id: string): Promise<StoredSession | null> {
  if (!SESSION_RE.test(id)) return null;
  const raw = await redis.get(sessionKey(id));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredSession>;
    return typeof v.userId === 'string' && v.userId ? { userId: v.userId, createdAt: String(v.createdAt ?? '') } : null;
  } catch {
    return null;
  }
}

export async function deleteSession(redis: Redis, id: string | null | undefined): Promise<void> {
  if (id && SESSION_RE.test(id)) await redis.del(sessionKey(id));
}

/** A new session for `userId` replacing the request's current one (ids rotate on every sign-in), with its cookie. */
export async function startSession(redis: Redis, env: Env, request: FastifyRequest, reply: FastifyReply, userId: string): Promise<string> {
  await deleteSession(redis, request.viewer?.sessionId).catch(() => undefined);
  const id = await createSession(redis, userId);
  reply.setCookie(SESSION_COOKIE, id, sessionCookieOptions(env));
  return id;
}

export function clearSessionCookie(env: Env, reply: FastifyReply) {
  const { maxAge: _maxAge, signed: _signed, ...opts } = sessionCookieOptions(env);
  reply.clearCookie(SESSION_COOKIE, opts);
}

/** The session id from the signed cookie, or null. */
function sessionIdOf(request: FastifyRequest): string | null {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const un = request.unsignCookie(raw);
  return un.valid && un.value && SESSION_RE.test(un.value) ? un.value : null;
}

/* ---------------- plugin ---------------- */

export async function registerSession(app: FastifyInstance, deps: { env: Env; redis: Redis; prisma: PrismaClient }) {
  const { env, redis, prisma } = deps;
  await app.register(cookie, { secret: env.SESSION_SECRET, hook: 'onRequest' });

  app.decorateRequest('sid', '');
  app.decorateRequest('sidIsNew', false);
  app.decorateRequest('viewer', null as unknown as FastifyRequest['viewer']);

  const allowed = new Set(allowedOrigins(env));

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // preflights, images and health checks never need a session; a Set-Cookie would also stop caches
    if (skipSession(request)) return;
    const raw = request.cookies?.[SID_COOKIE];
    let sid: string | null = null;
    if (raw) {
      const un = request.unsignCookie(raw);
      if (un.valid && un.value && SID_RE.test(un.value)) sid = un.value;
    }
    if (sid) {
      request.sid = sid;
    } else if (hasBearer(request)) {
      // M4: an API-key request (a server, not a browser) counts for the key's owner; no cookie for it
      request.sid = newSid();
    } else {
      request.sid = newSid();
      request.sidIsNew = true;
      reply.setCookie(SID_COOKIE, request.sid, sidCookieOptions(env));
    }
    // a state-changing request that carries the session must come from our own pages (SameSite=Lax already keeps
    // cross-site POSTs from sending it; this also covers other origins of the same site)
    const origin = request.headers.origin;
    if (request.method !== 'GET' && request.method !== 'HEAD' && origin && request.cookies?.[SESSION_COOKIE] && !originAllowed(env, allowed, origin)) {
      throw new ApiError(403, 'forbidden', 'Forbidden');
    }
  });

  // after the rate limits (onRequest), so a flood is cut before any lookup
  app.addHook('preHandler', async (request: FastifyRequest) => {
    request.viewer = { sid: request.sid, sessionId: null, user: null, apiKeyId: null };
    // M4: a request with an API key is that key's (plugins/apiKeys.ts resolves it next), never a cookie session's
    if (skipSession(request) || hasBearer(request)) return;
    const id = sessionIdOf(request);
    if (!id) return;
    const session = await readSession(redis, id).catch(() => null);
    if (!session) return;
    const user = await prisma.user.findUnique({ where: { id: session.userId } }).catch(() => null);
    if (!user) return;
    request.viewer = { sid: request.sid, sessionId: id, user };
    const now = Date.now();
    if (!user.lastSeenAt || now - user.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      void prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
    }
  });
}

/**
 * Set-Cookie header value for a hijacked reply (SSE): the cookie plugin writes cookies in
 * onSend, which never runs once a route takes over the raw response.
 */
export function sidSetCookieHeader(app: FastifyInstance, request: FastifyRequest, env: Env): string | null {
  if (!request.sidIsNew) return null;
  const { signed: _signed, ...opts } = sidCookieOptions(env);
  return app.serializeCookie(SID_COOKIE, app.signCookie(request.sid), opts);
}
