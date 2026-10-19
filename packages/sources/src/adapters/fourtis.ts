/**
 * Fourtis internal services (DevRadar, BundleScan, WhaleFlow) behind FOURTIS_API_URL + FOURTIS_API_KEY.
 *
 * The endpoints are not defined yet (Michael defines them). FOURTIS_PATHS holds the placeholder paths in
 * one place; the zod schemas below are the shapes this adapter expects back (a bare object or wrapped in
 * { data: … }). Change both here when the real API lands; nothing else depends on the wire format.
 */
import { z } from 'zod';
import { isChainKey, type ChainKey, type Env } from '@apecheck/core';
import { warnOnce } from '@apecheck/core/node';
import type { BundleScanFacts, DevRadarFacts, FourtisSource, Http, WhaleFlowFacts } from '../types';
import { HttpError } from '../http';
import { ErrorState } from '../util';

const TIMEOUT_MS = 8_000;

export const FOURTIS_PATHS = {
  devRadar: (chain: ChainKey, address: string) => `/devradar/${chain}/${encodeURIComponent(address)}`,
  bundleScan: (chain: ChainKey, address: string) => `/bundlescan/${chain}/${encodeURIComponent(address)}`,
  whaleFlow: (chain: ChainKey, address: string) => `/whaleflow/${chain}/${encodeURIComponent(address)}`,
} as const;

const pct = z.coerce.number().min(0).max(100);
const count = z.coerce.number().int().min(0);

export const DevRadarZ = z
  .object({
    deployer: z.string().min(1),
    fundedFrom: z.string().nullish(),
    launched: count,
    dead: count,
    firstSeen: z.string().nullish(),
    launches: z
      .array(
        z.object({
          address: z.string(),
          chain: z.string().nullish(),
          createdAt: z.string().nullish(),
          dead: z.boolean().optional().default(false),
        }),
      )
      .nullish(),
  })
  .refine(d => d.dead <= d.launched, { message: 'dead > launched' })
  .transform(
    (d): DevRadarFacts => ({
      deployer: d.deployer,
      fundedFrom: d.fundedFrom ?? null,
      launched: d.launched,
      dead: d.dead,
      firstSeen: d.firstSeen ?? null,
      ...(d.launches
        ? {
            launches: d.launches.map(l => ({
              address: l.address,
              chain: isChainKey(l.chain) ? l.chain : null,
              createdAt: l.createdAt ?? null,
              dead: l.dead,
            })),
          }
        : {}),
    }),
  );

export const BundleScanZ = z
  .object({
    bundlePct: pct,
    wallets: count,
    launchBlock: z.union([z.string(), z.number()]).nullish(),
  })
  .transform((b): BundleScanFacts => ({ bundlePct: b.bundlePct, wallets: b.wallets, launchBlock: b.launchBlock != null ? String(b.launchBlock) : null }));

export const WhaleFlowZ = z
  .object({
    top10Pct: pct,
    devHoldPct: pct,
    holders: count.nullish(),
    lp: z
      .object({
        status: z.enum(['burned', 'locked', 'unlocked']),
        lockedDays: z.coerce.number().min(0).nullish(),
      })
      .nullish(),
  })
  .transform(
    (w): WhaleFlowFacts => ({
      top10Pct: w.top10Pct,
      devHoldPct: w.devHoldPct,
      holders: w.holders ?? null,
      lp: w.lp ? { status: w.lp.status, lockedDays: w.lp.lockedDays ?? null } : null,
    }),
  );

/** accept { data: {...} } envelopes as well as bare objects */
function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in raw && (raw as { data: unknown }).data && typeof (raw as { data: unknown }).data === 'object') {
    return (raw as { data: unknown }).data;
  }
  return raw;
}

type FourtisEnv = Pick<Env, 'FOURTIS_API_URL' | 'FOURTIS_API_KEY'>;

export class FourtisAdapter implements FourtisSource {
  readonly configured: boolean;
  private readonly base: string;
  private readonly errors = new ErrorState('fourtis');

  constructor(private readonly env: FourtisEnv, private readonly http: Http) {
    this.configured = !!(env.FOURTIS_API_URL && env.FOURTIS_API_KEY);
    this.base = (env.FOURTIS_API_URL ?? '').replace(/\/+$/, '');
    if (!this.configured) {
      warnOnce('fourtis', 'Fourtis API not configured (FOURTIS_API_URL / FOURTIS_API_KEY empty): DevRadar, BundleScan and WhaleFlow are skipped, public on-chain fallbacks are used');
    }
  }

  get lastError() {
    return this.errors.lastError;
  }

  private async fetch<T>(op: string, path: string, schema: z.ZodType<T>): Promise<T | null> {
    if (!this.configured) return null;
    try {
      const raw = await this.http.json(`${this.base}${path}`, {
        headers: { authorization: `Bearer ${this.env.FOURTIS_API_KEY}` },
        timeoutMs: TIMEOUT_MS,
      });
      const parsed = schema.safeParse(unwrap(raw));
      if (!parsed.success) {
        this.errors.fail(op, new Error(`unexpected response shape (${parsed.error.issues[0]?.message ?? 'invalid'})`));
        return null;
      }
      return parsed.data;
    } catch (e) {
      // 404 = the service has no data for this coin, which is not an error
      if (e instanceof HttpError && e.status === 404) return null;
      this.errors.fail(op, e);
      return null;
    }
  }

  devRadar(chain: ChainKey, address: string): Promise<DevRadarFacts | null> {
    return this.fetch('devRadar', FOURTIS_PATHS.devRadar(chain, address), DevRadarZ);
  }
  bundleScan(chain: ChainKey, address: string): Promise<BundleScanFacts | null> {
    return this.fetch('bundleScan', FOURTIS_PATHS.bundleScan(chain, address), BundleScanZ);
  }
  whaleFlow(chain: ChainKey, address: string): Promise<WhaleFlowFacts | null> {
    return this.fetch('whaleFlow', FOURTIS_PATHS.whaleFlow(chain, address), WhaleFlowZ);
  }
}

export function createFourtis(env: FourtisEnv, http: Http): FourtisAdapter {
  return new FourtisAdapter(env, http);
}
