/**
 * API keys (M4, Max; HANDOFF §9, §11).
 *
 * A key is "ak_live_" + 32 random base62 characters (API_KEY_PREFIX). Only its SHA-256 (hex) is stored
 * (`ApiKey.hash`, unique) with the first 12 characters as `prefix` for the key list; the full key is shown once, when
 * it is created (routes/developer.ts). A request authenticates with "Authorization: Bearer ak_live_…":
 *
 *  - the key is looked up by its hash (no plaintext anywhere; keys are never logged);
 *  - unknown, malformed or revoked → 401 invalid_key (with `WWW-Authenticate: Bearer`);
 *  - API_KEY_RATE_PER_MIN requests per key per minute (Redis sliding window `rl:key:<id>`) on top of the per-IP
 *    limits → 429 rate_limited (`x-key-ratelimit-limit` / `-remaining` on every keyed response);
 *  - the key's owner must still be Max, tier re-read per the M3 rules (stored for an hour) → else 403 max_required;
 *  - `request.viewer` becomes { user: the owner, apiKeyId }, with no session (a session cookie sent along is ignored),
 *    so credits, private checks and asks count for the owner (MAX_CHECKS_PER_DAY) and checks are `via: API`;
 *  - `ApiKey.lastUsedAt` is written at most once a minute.
 *
 * Where keys work (`keyPolicy`): every developer route under /v1 and /mcp. Key and webhook management (/v1/keys,
 * /v1/webhooks) and the wallet session routes (/v1/auth/*) refuse a request that carries a key (403 forbidden), so a
 * leaked key can't mint more keys or point webhooks elsewhere.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_KEY_PREFIX } from '@apecheck/core';
import type { ApiKey } from '@apecheck/db';
import { viewerTier } from '../accounts';
import type { AppDeps } from '../context';
import { ApiError, MSG, maxForDevelopersMessage } from '../errors';
import { slidingLimit } from '../limits';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** random characters after the "ak_live_" prefix */
export const API_KEY_RANDOM_CHARS = 32;
export const API_KEY_RE = new RegExp(`^${API_KEY_PREFIX}[A-Za-z0-9]{${API_KEY_RANDOM_CHARS}}$`);
/** characters of the key kept as ApiKey.prefix ("ak_live_Ab3x") */
export const API_KEY_PREFIX_CHARS = 12;
/** ApiKey.lastUsedAt is written at most this often */
export const KEY_TOUCH_MS = 60_000;

/** `n` uniformly random base62 characters (rejection sampling: 248 = 4 × 62). */
export function randomBase62(n: number): string {
  let out = '';
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === n) break;
    }
  }
  return out;
}

export const generateApiKey = () => API_KEY_PREFIX + randomBase62(API_KEY_RANDOM_CHARS);
/** what ApiKey.hash holds: sha256 hex of the whole key */
export const hashApiKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');
export const apiKeyPrefixOf = (key: string) => key.slice(0, API_KEY_PREFIX_CHARS);
export const keyLimitKey = (apiKeyId: string) => `rl:key:${apiKeyId}`;

/** The request carries "Authorization: Bearer …" (any token): it is an API-key request. */
export function hasBearer(request: FastifyRequest): boolean {
  const h = request.headers.authorization;
  return typeof h === 'string' && /^bearer(?:\s|$)/i.test(h.trim());
}

/** The token of "Authorization: Bearer <token>", or null. */
export function bearerToken(request: FastifyRequest): string | null {
  const h = request.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

export type KeyPolicy = 'accept' | 'refuse' | 'ignore';

/** Whether the matched route takes an API key, refuses one (management, wallet sessions) or doesn't care. */
export function keyPolicy(request: FastifyRequest): KeyPolicy {
  const url = request.routeOptions?.url;
  // unmatched (404), CORS preflight ("*"), health and screenshots: the header plays no part
  if (!url || url === '*' || url === '/health' || url.startsWith('/shots')) return 'ignore';
  if (url === '/v1/keys' || url.startsWith('/v1/keys/') || url === '/v1/webhooks' || url.startsWith('/v1/webhooks/') || url.startsWith('/v1/auth/')) return 'refuse';
  if (url.startsWith('/v1/') || url === '/mcp') return 'accept';
  return 'ignore';
}

function invalidKey(reply: FastifyReply): never {
  reply.header('WWW-Authenticate', 'Bearer realm="apecheck", error="invalid_token"');
  throw new ApiError(401, 'invalid_key', MSG.invalidKey);
}

/** lastUsedAt at most once a minute (a conditional write, so concurrent requests write once). */
async function touchKey(deps: Pick<AppDeps, 'prisma'>, key: Pick<ApiKey, 'id' | 'lastUsedAt'>, now = Date.now()): Promise<void> {
  if (key.lastUsedAt && now - key.lastUsedAt.getTime() < KEY_TOUCH_MS) return;
  const cut = new Date(now - KEY_TOUCH_MS);
  await deps.prisma.apiKey
    .updateMany({ where: { id: key.id, revokedAt: null, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cut } }] }, data: { lastUsedAt: new Date(now) } })
    .catch(() => undefined);
}

/** Resolve the Bearer key of a request into `request.viewer` (see the file comment). Throws ApiError 401/403/429. */
export async function authenticateKey(deps: AppDeps, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(request);
  if (!token || !API_KEY_RE.test(token)) invalidKey(reply);
  const key = await deps.prisma.apiKey.findUnique({ where: { hash: hashApiKey(token) }, include: { user: true } });
  if (!key || key.revokedAt) invalidKey(reply);

  const limit = deps.env.API_KEY_RATE_PER_MIN;
  const hit = await slidingLimit(deps.redis, keyLimitKey(key.id), limit, 60_000);
  // the x-ratelimit-* headers are the per-IP bucket's; these are the key's
  reply.header('x-key-ratelimit-limit', String(limit));
  reply.header('x-key-ratelimit-remaining', String(Math.max(0, limit - hit.count)));
  if (!hit.ok) {
    reply.header('Retry-After', String(Math.max(1, Math.ceil(hit.retryAfterMs / 1000))));
    throw new ApiError(429, 'rate_limited', MSG.keyRateLimited);
  }

  request.viewer = { sid: request.sid, sessionId: null, user: key.user, apiKeyId: key.id };
  const tier = await viewerTier(deps, request);
  if (tier?.tier !== 'max') throw new ApiError(403, 'max_required', maxForDevelopersMessage(deps.env));
  await touchKey(deps, key);
}

/**
 * Register after the session plugin: its preHandler leaves a Bearer request signed out, and this one resolves the key
 * (route rate limits ran before both, in onRequest).
 */
export function registerApiKeyAuth(app: FastifyInstance, deps: AppDeps) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasBearer(request)) return;
    const policy = keyPolicy(request);
    if (policy === 'ignore') return;
    if (policy === 'refuse') throw new ApiError(403, 'forbidden', MSG.keyNotForManagement);
    await authenticateKey(deps, request, reply);
  });
}

/** The viewer authenticated with an API key (REST or MCP). */
export const viaKey = (request: FastifyRequest) => !!request.viewer?.apiKeyId;
