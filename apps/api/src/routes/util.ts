import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CHAIN_ORDER, COIN_BANDS, NAR_BANDS, chainToDb, tierFromDb, type ChainKey, type CoinKey, type NarKey } from '@apecheck/core';
import type { Viewer } from '../mappers';

/**
 * The anonymous cookie id and the signed-in user (M3) of a request: "mine" flags and private-check access. The tier
 * (M4: Pro/Max extras) is the user's stored one: call viewerTier() first where it matters, it refreshes the stored row.
 */
export const viewerOf = (req: FastifyRequest): Viewer => {
  const user = req.viewer?.user ?? null;
  return { sid: req.sid || null, userId: user?.id ?? null, tier: user ? tierFromDb(user.tier) : null };
};

/** Empty query values (`?nar=`) count as "not given". */
export const opt = <T extends z.ZodType>(schema: T) => z.preprocess(v => (v === '' ? undefined : v), schema);

export const NarZ = z.enum(NAR_BANDS.map(b => b.key) as [NarKey, ...NarKey[]]);
export const CoinBandZ = z.enum(COIN_BANDS.map(b => b.key) as [CoinKey, ...CoinKey[]]);
export const ChainZ = z.enum(CHAIN_ORDER as [ChainKey, ...ChainKey[]]);
/** chain filter: a chain key, or any/all for no filter */
export const ChainFilterZ = opt(z.union([ChainZ, z.literal('any'), z.literal('all')]).default('any'));

export const chainDbOf = (v: string) => (v === 'any' || v === 'all' ? null : chainToDb(v as ChainKey));

/** search text: trimmed, leading $ / @ dropped (people paste "$ORBIT" and "@kairolabs") */
export const searchTerm = (q: string | undefined) => (q ?? '').trim().replace(/^[$@]+/, '').trim();

export const startOfUtcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
