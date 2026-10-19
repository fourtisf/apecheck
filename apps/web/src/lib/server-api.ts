/**
 * Server-only helpers for calling the API from server components and route handlers.
 * Never import this from a 'use client' file (next/headers only exists on the server).
 */
import { headers } from 'next/headers';
import type { CallOpts } from './api';

/**
 * The API trusts X-Forwarded-For from loopback only (apps/api trustProxy: 'loopback'). Server renders
 * reach it from 127.0.0.1, so pass the visitor's chain along: rate limits then count the visitor
 * instead of putting every server render in one bucket. Nginx appends the real client address, and
 * the API reads the chain from the right, so a spoofed header can't pick another IP.
 */
export function forwardedHeaders(): Record<string, string> {
  const h = headers();
  const out: Record<string, string> = {};
  const xff = h.get('x-forwarded-for');
  if (xff) out['x-forwarded-for'] = xff;
  const ua = h.get('user-agent');
  if (ua) out['user-agent'] = ua;
  return out;
}

/** CallOpts for a server render: forwarded headers, default timeout. */
export function serverCall(): CallOpts {
  return { headers: forwardedHeaders() };
}

/** Run an API call during a server render; a failure renders the client's "couldn't load" state instead of a 500. */
export async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}
