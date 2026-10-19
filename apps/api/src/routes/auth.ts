/**
 * Wallet sign-in and the X link (M3).
 *
 *   GET  /v1/auth/nonce?chain=evm|sol&address=…[&chainId=…]  → AuthNonceResponse (the exact message to sign; EVM
 *                                                              Chain ID = the wallet's chain, else the smart-wallet one)
 *   POST /v1/auth/verify   AuthVerifyBody                      → MeDTO + session cookie (or links the wallet)
 *   POST /v1/auth/logout                                       → { ok: true }
 *   GET  /v1/auth/x/start                                      → 302 to X (PKCE)
 *   GET  /v1/auth/x/callback                                   → 302 to APP_URL/?x=linked | ?x=error[&reason=…]
 *   POST /v1/auth/x/unlink                                     → MeDTO
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CHAINS, authNonceKey, type AuthNonceResponse, type MeDTO, type WalletChain } from '@apecheck/core';
import { Prisma } from '@apecheck/db';
import { buildMe, signInWallet, viewerTier, walletKey } from '../accounts';
import {
  MessageError,
  NONCE_TTL_MS,
  RE_EVM_ADDRESS,
  RE_SOL_ADDRESS,
  appIdentity,
  buildSignInMessage,
  parseSignInMessage,
  validateSignInFields,
} from '../auth/message';
import { contractWalletChain, verifyEvmSignature } from '../auth/evm';
import { solanaPublicKey, verifySolanaSignature } from '../auth/solana';
import { XLinkError, startXLink, takeXState, xAccountFromCode } from '../auth/x-oauth';
import type { AppDeps } from '../context';
import { ApiError, MSG, smartWalletChainMessage, smartWalletUnavailableMessage } from '../errors';
import { userBurst } from '../limits';
import { clearSessionCookie, deleteSession, startSession } from '../plugins/session';

/**
 * per-IP route limits (per minute). Verify has no per-wallet limit on purpose: a signature can't be guessed, and a
 * limit keyed on an address anyone can type would let anyone lock that wallet out of signing in.
 */
export const AUTH_RATE = { nonce: 30, verify: 20, logout: 20, xStart: 10, xCallback: 20, xUnlink: 10 } as const;

const ChainZ = z.enum(['evm', 'sol']);
const NonceQueryZ = z.object({
  chain: ChainZ,
  address: z.string().trim().max(64),
  chainId: z.preprocess(v => (v === '' || v == null ? undefined : v), z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()),
});
const VerifyBodyZ = z.object({
  chain: ChainZ,
  address: z.string().trim().max(64),
  message: z.string().max(4000),
  signature: z.string().trim().min(1).max(9000),
});

interface StoredNonce {
  chain: WalletChain;
  address: string;
  message: string;
}

const rate = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

/** The address in its canonical form for the chain, or a 400. */
function walletAddress(chain: WalletChain, address: string): string {
  if (chain === 'evm') {
    if (!RE_EVM_ADDRESS.test(address)) throw new ApiError(400, 'bad_request', 'That is not an EVM wallet address.');
    return address;
  }
  if (!RE_SOL_ADDRESS.test(address) || !solanaPublicKey(address)) throw new ApiError(400, 'bad_request', 'That is not a Solana wallet address.');
  return address;
}

/** 62-character alphabet nonce (EIP-4361: alphanumeric, at least 8 characters) */
function newNonce(len = 20): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(len * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < len; i++) if (bytes[i] < 248) out += alphabet[bytes[i] % 62];
  return out.length === len ? out : newNonce(len);
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps) {
  const { env, redis, prisma } = deps;

  app.get('/v1/auth/nonce', rate(AUTH_RATE.nonce), async (request, reply): Promise<AuthNonceResponse> => {
    const q = NonceQueryZ.parse(request.query ?? {});
    const address = walletAddress(q.chain, q.address);
    const { domain, uri } = appIdentity(env.APP_URL);
    const nonce = newNonce();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
    // EVM: the wallet's own chain (a key signs the same on every chain); without one, the only chain a smart wallet
    // is checked on (verify requires that Chain ID for EIP-1271)
    const chainId = q.chainId ?? contractWalletChain(env)?.chainId ?? 1;
    const message = buildSignInMessage({ chain: q.chain, domain, uri, address, chainId, nonce, issuedAt, expirationTime: expiresAt });
    const stored: StoredNonce = { chain: q.chain, address: walletKey(q.chain, address), message };
    await redis.set(authNonceKey(nonce), JSON.stringify(stored), 'PX', NONCE_TTL_MS);
    reply.header('Cache-Control', 'no-store');
    return { nonce, message, expiresAt: expiresAt.toISOString() };
  });

  app.post('/v1/auth/verify', rate(AUTH_RATE.verify), async (request, reply): Promise<MeDTO> => {
    const body = VerifyBodyZ.parse(request.body ?? {});
    const address = walletAddress(body.chain, body.address);

    let fields;
    try {
      fields = parseSignInMessage(body.chain, body.message);
    } catch (e) {
      if (e instanceof MessageError) throw new ApiError(400, 'bad_message', MSG.badMessage);
      throw e;
    }
    // single use: taken before anything else is checked, so a failed attempt can't be retried with the same nonce
    const raw = await redis.getdel(authNonceKey(fields.nonce));
    if (!raw) throw new ApiError(401, 'nonce_expired', MSG.nonceExpired);
    let stored: StoredNonce;
    try {
      stored = JSON.parse(raw) as StoredNonce;
    } catch {
      throw new ApiError(401, 'nonce_expired', MSG.nonceExpired);
    }
    // the message must be the one this nonce was issued with, for this chain and this wallet
    if (stored.chain !== body.chain || stored.address !== walletKey(body.chain, address) || stored.message !== body.message) {
      throw new ApiError(400, 'bad_message', MSG.badMessage);
    }
    const { domain, uri } = appIdentity(env.APP_URL);
    try {
      validateSignInFields(fields, { chain: body.chain, domain, uri, address, nonce: fields.nonce });
    } catch (e) {
      if (e instanceof MessageError) {
        throw e.reason === 'expired' ? new ApiError(401, 'nonce_expired', MSG.nonceExpired) : new ApiError(400, 'bad_message', MSG.badMessage);
      }
      throw e;
    }

    if (body.chain === 'evm') {
      // a smart wallet is checked on one server-chosen chain only (TOKEN_CHAIN when it is EVM), named by the message
      const r = await verifyEvmSignature(deps.sources, address, body.message, body.signature, {
        signedChainId: fields.chainId,
        contract: contractWalletChain(env),
      });
      if (!r.ok) {
        const chainName = r.chain ? CHAINS[r.chain].name : '';
        if (r.reason === 'unavailable') throw new ApiError(503, 'wallet_check_unavailable', smartWalletUnavailableMessage(chainName));
        throw new ApiError(401, 'bad_signature', r.reason === 'wrong_chain' ? smartWalletChainMessage(chainName) : MSG.badSignature);
      }
    } else if (!verifySolanaSignature(address, body.message, body.signature)) {
      throw new ApiError(401, 'bad_signature', MSG.badSignature);
    }

    const { user } = await signInWallet(deps, request, body.chain, address);
    await startSession(redis, env, request, reply, user.id);
    request.viewer = { ...request.viewer, user };
    // the balance is read on every sign-in
    const tier = await viewerTier(deps, request, { force: true });
    return buildMe(deps, request, { tier });
  });

  app.post('/v1/auth/logout', rate(AUTH_RATE.logout), async (request, reply) => {
    await deleteSession(redis, request.viewer?.sessionId).catch(() => undefined);
    clearSessionCookie(env, reply);
    return { ok: true };
  });

  /* ---------------- X link (OAuth 2.0 + PKCE) ---------------- */

  const back = (reply: FastifyReply, result: 'linked' | 'error', reason?: string) => {
    const q = new URLSearchParams({ x: result, ...(reason ? { reason } : {}) });
    return reply.redirect(`${env.APP_URL.replace(/\/+$/, '')}/?${q}`, 302);
  };

  app.get('/v1/auth/x/start', rate(AUTH_RATE.xStart), async (request, reply) => {
    if (!env.X_OAUTH2_CLIENT_ID) throw new ApiError(404, 'x_link_unavailable', MSG.xUnavailable);
    const user = request.viewer.user;
    if (!user) throw new ApiError(401, 'sign_in_required', MSG.signInFirst);
    await userBurst(redis, 'xLink', user.id);
    const url = await startXLink(redis, env, user.id);
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(url, 302);
  });

  app.get('/v1/auth/x/callback', rate(AUTH_RATE.xCallback), async (request: FastifyRequest, reply) => {
    if (!env.X_OAUTH2_CLIENT_ID) throw new ApiError(404, 'x_link_unavailable', MSG.xUnavailable);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const state = typeof q.state === 'string' ? q.state : '';
    const stored = state ? await takeXState(redis, state) : null;
    if (typeof q.error === 'string') return back(reply, 'error', q.error === 'access_denied' ? 'denied' : undefined);
    const code = typeof q.code === 'string' && q.code.length <= 2000 ? q.code : '';
    const user = request.viewer.user;
    // the flow must finish in the browser (and account) that started it
    if (!stored || !code || !user || stored.userId !== user.id) return back(reply, 'error');

    let account: { id: string; username: string };
    try {
      account = await xAccountFromCode(deps.sources.http, env, code, stored.verifier);
    } catch (err) {
      request.log.warn({ err: err instanceof XLinkError ? err.message : err }, 'x link failed');
      return back(reply, 'error');
    }
    try {
      await prisma.$transaction(async tx => {
        const owner = await tx.user.findUnique({ where: { xUserId: account.id }, select: { id: true } });
        if (owner && owner.id !== user.id) throw new ApiError(409, 'x_taken', 'taken');
        // a handle can move between X accounts: whoever held it before (another X id) loses the stale handle
        await tx.user.updateMany({ where: { xHandle: account.username, id: { not: user.id } }, data: { xHandle: null } });
        await tx.user.update({ where: { id: user.id }, data: { xHandle: account.username, xUserId: account.id } });
      });
    } catch (err) {
      if (err instanceof ApiError || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) return back(reply, 'error', 'taken');
      throw err;
    }
    return back(reply, 'linked');
  });

  app.post('/v1/auth/x/unlink', rate(AUTH_RATE.xUnlink), async (request): Promise<MeDTO> => {
    const user = request.viewer.user;
    if (!user) throw new ApiError(401, 'sign_in_required', MSG.signInFirst);
    await userBurst(redis, 'xLink', user.id);
    const updated = await prisma.user.update({ where: { id: user.id }, data: { xHandle: null, xUserId: null } });
    request.viewer = { ...request.viewer, user: updated };
    return buildMe(deps, request);
  });
}
