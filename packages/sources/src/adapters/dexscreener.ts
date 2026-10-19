/**
 * DexScreener public API (no key). Token pairs → the most liquid pair for a token.
 * https://docs.dexscreener.com/api/reference
 */
import { z } from 'zod';
import { CHAINS, chainFromDex, type ChainKey, type Env } from '@apecheck/core';
import type { DexScreenerSource, DexTokenInfo, Http } from '../types';
import { ErrorState, isoFromMs, num } from '../util';

const TIMEOUT_MS = 8_000;
/** /tokens/v1 accepts up to 30 comma-separated addresses */
export const DEX_BATCH = 30;

const TokenRefZ = z.object({
  address: z.string(),
  name: z.string().nullish(),
  symbol: z.string().nullish(),
});
const NumLikeZ = z.union([z.number(), z.string()]).nullish();
const PairZ = z.object({
  chainId: z.string(),
  dexId: z.string().nullish(),
  url: z.string().nullish(),
  pairAddress: z.string().nullish(),
  baseToken: TokenRefZ,
  quoteToken: TokenRefZ.nullish(),
  priceNative: NumLikeZ,
  priceUsd: NumLikeZ,
  volume: z.record(z.string(), NumLikeZ).nullish(),
  priceChange: z.record(z.string(), NumLikeZ).nullish(),
  liquidity: z.object({ usd: NumLikeZ }).partial().nullish(),
  fdv: NumLikeZ,
  marketCap: NumLikeZ,
  pairCreatedAt: NumLikeZ,
  info: z
    .object({
      imageUrl: z.string().nullish(),
      websites: z.array(z.object({ url: z.string().nullish(), label: z.string().nullish() }).partial()).nullish(),
      socials: z
        .array(z.object({ type: z.string().nullish(), platform: z.string().nullish(), url: z.string().nullish(), handle: z.string().nullish() }).partial())
        .nullish(),
    })
    .partial()
    .nullish(),
});
type Pair = z.infer<typeof PairZ>;

/** Keep pairs that parse; one malformed pair must not hide the rest. */
function parsePairs(raw: unknown): Pair[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { pairs?: unknown }).pairs : null;
  if (!Array.isArray(list)) return [];
  const out: Pair[] = [];
  for (const p of list) {
    const r = PairZ.safeParse(p);
    if (r.success) out.push(r.data);
  }
  return out;
}

const sameAddress = (a: string, b: string) => (a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b);
const liq = (p: Pair) => num(p.liquidity?.usd) ?? 0;

function socialUrl(type: string, handle: string): string | null {
  if (/^https?:\/\//i.test(handle)) return handle;
  const h = handle.replace(/^@/, '');
  if (type === 'twitter' || type === 'x') return `https://x.com/${h}`;
  if (type === 'telegram') return `https://t.me/${h}`;
  return null;
}

export function mapPair(p: Pair): DexTokenInfo | null {
  const chain = chainFromDex(p.chainId);
  if (!chain) return null;
  const websites = (p.info?.websites ?? []).map(w => w.url).filter((u): u is string => !!u);
  const socials: { type: string; url: string }[] = [];
  for (const s of p.info?.socials ?? []) {
    const type = (s.type ?? s.platform ?? '').toLowerCase();
    const url = s.url ?? (s.handle ? socialUrl(type, s.handle) : null);
    if (type && url) socials.push({ type, url });
  }
  const fdv = num(p.fdv);
  return {
    chain,
    address: p.baseToken.address,
    name: p.baseToken.name ?? null,
    symbol: p.baseToken.symbol ?? null,
    priceUsd: num(p.priceUsd),
    mc: num(p.marketCap) ?? fdv,
    fdv,
    liquidityUsd: num(p.liquidity?.usd),
    vol5m: num(p.volume?.m5),
    vol24h: num(p.volume?.h24),
    ch24: num(p.priceChange?.h24),
    pairAddress: p.pairAddress ?? null,
    pairUrl: p.url ?? null,
    dex: p.dexId ?? null,
    pairCreatedAt: isoFromMs(p.pairCreatedAt),
    websites,
    socials,
    imageUrl: p.info?.imageUrl ?? null,
  };
}

/** Most liquid pair where the token is the base token, on a chain ApeCheck knows. */
export function bestPair(pairs: Pair[], address: string, chain: ChainKey | null): Pair | null {
  let best: Pair | null = null;
  for (const p of pairs) {
    const c = chainFromDex(p.chainId);
    if (!c || (chain && c !== chain)) continue;
    if (!sameAddress(p.baseToken.address, address)) continue;
    if (!best || liq(p) > liq(best)) best = p;
  }
  return best;
}

export class DexScreenerAdapter implements DexScreenerSource {
  readonly configured = true;
  private readonly base: string;
  private readonly errors = new ErrorState('dexscreener');

  constructor(env: Pick<Env, 'DEXSCREENER_BASE'>, private readonly http: Http) {
    this.base = env.DEXSCREENER_BASE.replace(/\/+$/, '');
  }

  get lastError() {
    return this.errors.lastError;
  }

  private get(path: string): Promise<unknown> {
    return this.http.json(`${this.base}${path}`, { timeoutMs: TIMEOUT_MS });
  }

  async token(chain: ChainKey | null, address: string): Promise<DexTokenInfo | null> {
    const a = address.trim();
    if (!a) return null;
    try {
      const raw = chain
        ? await this.get(`/tokens/v1/${CHAINS[chain].dex}/${encodeURIComponent(a)}`)
        : await this.get(`/latest/dex/tokens/${encodeURIComponent(a)}`);
      const best = bestPair(parsePairs(raw), a, chain);
      return best ? mapPair(best) : null;
    } catch (e) {
      this.errors.fail('token', e);
      return null;
    }
  }

  async tokens(chain: ChainKey, addresses: string[]): Promise<Map<string, DexTokenInfo>> {
    const out = new Map<string, DexTokenInfo>();
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of addresses) {
      const a = raw.trim();
      if (!a || seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      list.push(a);
    }
    for (let i = 0; i < list.length; i += DEX_BATCH) {
      const batch = list.slice(i, i + DEX_BATCH);
      try {
        const pairs = parsePairs(await this.get(`/tokens/v1/${CHAINS[chain].dex}/${batch.map(encodeURIComponent).join(',')}`));
        for (const a of batch) {
          const best = bestPair(pairs, a, chain);
          const info = best ? mapPair(best) : null;
          if (info) out.set(a.toLowerCase(), info);
        }
      } catch (e) {
        this.errors.fail('tokens', e);
      }
    }
    return out;
  }

  async search(query: string): Promise<DexTokenInfo[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      const pairs = parsePairs(await this.get(`/latest/dex/search?q=${encodeURIComponent(q)}`));
      const byToken = new Map<string, Pair>();
      for (const p of pairs) {
        const chain = chainFromDex(p.chainId);
        if (!chain) continue;
        const key = `${chain}:${p.baseToken.address.toLowerCase()}`;
        const cur = byToken.get(key);
        if (!cur || liq(p) > liq(cur)) byToken.set(key, p);
      }
      return [...byToken.values()]
        .sort((a, b) => liq(b) - liq(a))
        .map(mapPair)
        .filter((t): t is DexTokenInfo => !!t);
    } catch (e) {
      this.errors.fail('search', e);
      return [];
    }
  }
}

export function createDexScreener(env: Pick<Env, 'DEXSCREENER_BASE'>, http: Http): DexScreenerAdapter {
  return new DexScreenerAdapter(env, http);
}
