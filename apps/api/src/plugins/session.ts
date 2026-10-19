/**
 * Anonymous session: every visitor gets a random 24-byte id in a signed, httpOnly cookie.
 * It keys credits and the "You" badges (Check.requesterSid). Signed-in sessions are M3.
 */
import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SID_COOKIE, isProd, type Env } from '@apecheck/core';

const SID_RE = /^[A-Za-z0-9_-]{32}$/;
const ONE_YEAR_S = 365 * 24 * 3600;

export const newSid = () => randomBytes(24).toString('base64url');

export function sidCookieOptions(env: Env) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProd(env),
    path: '/',
    maxAge: ONE_YEAR_S,
  };
}

export async function registerSession(app: FastifyInstance, env: Env) {
  await app.register(cookie, { secret: env.SESSION_SECRET, hook: 'onRequest' });

  app.decorateRequest('sid', '');
  app.decorateRequest('sidIsNew', false);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // preflights, images and health checks never need a session; a Set-Cookie would also stop caches
    if (request.method === 'OPTIONS' || request.url.startsWith('/shots/') || request.url === '/health') return;
    const raw = request.cookies?.[SID_COOKIE];
    if (raw) {
      const un = request.unsignCookie(raw);
      if (un.valid && un.value && SID_RE.test(un.value)) {
        request.sid = un.value;
        return;
      }
    }
    request.sid = newSid();
    request.sidIsNew = true;
    reply.setCookie(SID_COOKIE, request.sid, sidCookieOptions(env));
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
