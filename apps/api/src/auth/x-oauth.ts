/**
 * "Link your X" (M3): OAuth 2.0 authorization code with PKCE (scopes users.read tweet.read), only to learn which X
 * account the signed-in user owns (User.xHandle / xUserId), so bot limits and asks follow the wallet's tier.
 * No X token is stored.
 *
 *  start:    state (24 random bytes) + code verifier (48 random bytes) in Redis under xOauthStateKey(state) for
 *            10 minutes, bound to the signed-in user; 302 to x.com/i/oauth2/authorize with the S256 challenge.
 *  callback: the state is taken once (GETDEL) and must belong to the same signed-in user (an authorize link someone
 *            else started can't link their X to you); the code is exchanged at api.x.com/2/oauth2/token (HTTP Basic
 *            with the client id/secret, or the client id in the body for a public client), then /2/users/me.
 * All calls go through the sources Http (timeouts, OUTBOUND_PROXY).
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { xOauthStateKey, type Env } from '@apecheck/core';
import type { Http } from '@apecheck/sources';
import type { Redis } from 'ioredis';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_ME_URL = 'https://api.x.com/2/users/me';
export const X_SCOPES = 'users.read tweet.read';
export const X_STATE_TTL_S = 600;
const TIMEOUT_MS = 10_000;

export const xRedirectUri = (env: Pick<Env, 'API_URL'>) => `${env.API_URL.replace(/\/+$/, '')}/v1/auth/x/callback`;
const b64url = (b: Buffer) => b.toString('base64url');
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

interface StoredState {
  userId: string;
  verifier: string;
}

/** Stores a fresh state for `userId` and returns the X authorize URL to redirect to. */
export async function startXLink(redis: Redis, env: Env, userId: string): Promise<string> {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const value: StoredState = { userId, verifier };
  await redis.set(xOauthStateKey(state), JSON.stringify(value), 'EX', X_STATE_TTL_S);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env.X_OAUTH2_CLIENT_ID!,
    redirect_uri: xRedirectUri(env),
    scope: X_SCOPES,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return `${X_AUTHORIZE_URL}?${q.toString().replace(/\+/g, '%20')}`;
}

/** The state's stored value, taken once; null when unknown, expired or already used. */
export async function takeXState(redis: Redis, state: string): Promise<StoredState | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(state)) return null;
  const raw = await redis.getdel(xOauthStateKey(state));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredState>;
    return typeof v.userId === 'string' && typeof v.verifier === 'string' ? { userId: v.userId, verifier: v.verifier } : null;
  } catch {
    return null;
  }
}

const TokenZ = z.object({ access_token: z.string().min(1), token_type: z.string().optional() });
const MeZ = z.object({ data: z.object({ id: z.string().regex(/^\d{1,25}$/), username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/) }) });

export class XLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XLinkError';
  }
}

/** Code → access token → the X account behind it. Throws XLinkError with the reason. */
export async function xAccountFromCode(http: Http, env: Env, code: string, verifier: string): Promise<{ id: string; username: string }> {
  const form = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri: xRedirectUri(env),
    code_verifier: verifier,
    client_id: env.X_OAUTH2_CLIENT_ID!,
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (env.X_OAUTH2_CLIENT_SECRET) {
    headers.authorization = 'Basic ' + Buffer.from(`${env.X_OAUTH2_CLIENT_ID}:${env.X_OAUTH2_CLIENT_SECRET}`).toString('base64');
  }
  const tokenRes = await http.request(X_TOKEN_URL, { method: 'POST', headers, body: form.toString(), timeoutMs: TIMEOUT_MS, redirect: false });
  if (!tokenRes.ok) throw new XLinkError(`token exchange: HTTP ${tokenRes.status}`);
  let token: z.infer<typeof TokenZ>;
  try {
    token = TokenZ.parse(JSON.parse(tokenRes.text));
  } catch {
    throw new XLinkError('token exchange: unexpected response');
  }
  const meRes = await http.request(X_ME_URL, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
    timeoutMs: TIMEOUT_MS,
    redirect: false,
  });
  if (!meRes.ok) throw new XLinkError(`users/me: HTTP ${meRes.status}`);
  try {
    return MeZ.parse(JSON.parse(meRes.text)).data;
  } catch {
    throw new XLinkError('users/me: unexpected response');
  }
}
