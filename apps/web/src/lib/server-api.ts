/**
 * Server-only helpers for calling the API from server components and route handlers.
 * Never import this from a 'use client' file (next/headers only exists on the server).
 */
import { headers } from 'next/headers';
import { SESSION_COOKIE, SID_COOKIE } from '@apecheck/core';
import type { CallOpts } from './api';

/** The API's own cookies; nothing else the browser sends to the site is passed on. */
const API_COOKIES: ReadonlySet<string> = new Set([SID_COOKIE, SESSION_COOKIE]);

/**
 * The `Cookie` header to send the API: only its anonymous session (ac_sid) and the signed-in session (ac_session),
 * as the visitor's browser sent them to the site. In production both are set for COOKIE_DOMAIN=.apecheck.io, so a
 * server render sees the visitor as the API would ("mine", "watching", private reports, tier). Empty → null.
 */
export function apiCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const keep: string[] = [];
  const seen = new Set<string>();
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    // the first of two same-named cookies is the more specific one (RFC 6265 §5.4): keep that one only
    if (!API_COOKIES.has(name) || seen.has(name) || !value || /[\r\n]/.test(value)) continue;
    seen.add(name);
    keep.push(`${name}=${value}`);
  }
  return keep.length ? keep.join('; ') : null;
}

/**
 * What a server render passes on to the API:
 * - X-Forwarded-For: the API trusts it from loopback only (apps/api trustProxy: 'loopback'). Server renders reach it
 *   from 127.0.0.1, so pass the visitor's chain along: rate limits then count the visitor instead of putting every
 *   server render in one bucket. Nginx appends the real client address, and the API reads the chain from the right,
 *   so a spoofed header can't pick another IP.
 * - Cookie: the API's own session cookies (apiCookieHeader), so the first paint shows the visitor's own view.
 * - User-Agent.
 */
export function forwardedHeaders(): Record<string, string> {
  const h = headers();
  const out: Record<string, string> = {};
  const xff = h.get('x-forwarded-for');
  if (xff) out['x-forwarded-for'] = xff;
  const ua = h.get('user-agent');
  if (ua) out['user-agent'] = ua;
  const cookie = apiCookieHeader(h.get('cookie'));
  if (cookie) out.cookie = cookie;
  return out;
}

/** CallOpts for a server render: forwarded headers, default timeout. */
export function serverCall(opts: { timeoutMs?: number } = {}): CallOpts {
  return { headers: forwardedHeaders(), ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}) };
}

/** Run an API call during a server render; a failure renders the client's "couldn't load" state instead of a 500. */
export async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}
