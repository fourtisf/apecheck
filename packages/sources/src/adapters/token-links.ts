/**
 * Token links from free sources, for coins DexScreener has no "Enhanced Token Info" for:
 *
 *  - metadata(): the token's own metadata. Solana only (EVM / Tron tokens carry no link metadata on-chain).
 *    With HELIUS_API_KEY: Helius DAS getAsset (content.json_uri, content.links.image / external_url,
 *    content.metadata); otherwise, or when DAS fails, one getMultipleAccounts for the mint (jsonParsed: the
 *    Token-2022 tokenMetadata extension) and its Metaplex metadata PDA (base64, Borsh-decoded name/symbol/uri).
 *    Then the metadata JSON at the URI, through the SSRF guard (256 KB, 8 s; ipfs:// / ar:// via a public
 *    gateway): image, website, twitter, telegram, discord, top-level (pump.fun) or under "extensions".
 *  - gecko(): GeckoTerminal token info, every mapped chain, no key:
 *    GET /api/v2/networks/{network}/tokens/{address}/info → image_url, websites[], twitter_handle,
 *    telegram_handle, discord_url, description.
 *
 * Parsing is tolerant (unknown fields ignored, wrong types skipped); every failure resolves null and is reported.
 */
import { z } from 'zod';
import type { ChainKey, Env } from '@apecheck/core';
import type { Http, TokenLinks, TokenLinksSource } from '../types';
import { HttpError } from '../http';
import { emptyLinks, gatewayUrl } from '../links';
import { decodeMetaplexMetadata, metadataPda } from '../solana-pda';
import { PUBLIC_SOLANA_RPC, TOKEN_2022_PROGRAM, solanaRpcUrl } from './solana';
import { jsonRpc } from '../rpc';
import { ErrorState, RE_EVM_ADDRESS, RE_SOL_ADDRESS, RE_TRON_ADDRESS } from '../util';

export const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';
/** ApeCheck chain → GeckoTerminal network id (Robinhood Chain: not mapped) */
export const GECKO_NETWORKS: Partial<Record<ChainKey, string>> = {
  sol: 'solana',
  eth: 'eth',
  base: 'base',
  bnb: 'bsc',
  arb: 'arbitrum',
  trx: 'tron',
};
export const GECKO_TIMEOUT_MS = 8_000;
export const META_JSON_TIMEOUT_MS = 8_000;
export const META_JSON_MAX_BYTES = 256 * 1024;
const RPC_TIMEOUT_MS = 6_000;
const META_RPC_METHODS: ReadonlySet<string> = new Set(['getMultipleAccounts']);

const str = z.string().nullish().catch(null);
const strList = z.array(z.unknown()).nullish().catch(null);

/* ---------- GeckoTerminal ---------- */

const GeckoInfoZ = z.object({
  data: z.object({
    attributes: z
      .object({
        name: str,
        symbol: str,
        image_url: str,
        image: z.object({ large: str, small: str, thumb: str }).partial().nullish().catch(null),
        websites: strList,
        twitter_handle: str,
        telegram_handle: str,
        discord_url: str,
        description: str,
      })
      .partial(),
  }),
});

/** GeckoTerminal /tokens/{address}/info body → TokenLinks; null when it isn't one. */
export function parseGeckoInfo(raw: unknown): TokenLinks | null {
  const r = GeckoInfoZ.safeParse(raw);
  if (!r.success) return null;
  const a = r.data.data.attributes;
  const out = emptyLinks();
  out.name = a.name ?? null;
  out.symbol = a.symbol ?? null;
  out.description = a.description ? a.description.slice(0, 2000) : null;
  out.websites = (a.websites ?? []).filter((w): w is string => typeof w === 'string');
  if (a.twitter_handle) out.twitter.push(a.twitter_handle);
  if (a.telegram_handle) out.telegram.push(a.telegram_handle);
  if (a.discord_url) out.discord.push(a.discord_url);
  out.image = a.image?.large ?? a.image_url ?? a.image?.small ?? null;
  return out;
}

/* ---------- metadata JSON ---------- */

/** The links in a token metadata JSON (Metaplex / pump.fun style); null when it isn't an object. */
export function parseMetadataJson(raw: unknown): TokenLinks | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const ext = o.extensions && typeof o.extensions === 'object' && !Array.isArray(o.extensions) ? (o.extensions as Record<string, unknown>) : {};
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const pick = (...vals: unknown[]) => vals.map(s).filter((v): v is string => !!v);
  const out = emptyLinks();
  out.name = s(o.name);
  out.symbol = s(o.symbol);
  out.description = s(o.description)?.slice(0, 2000) ?? null;
  out.image = s(o.image) ?? s(o.logo) ?? s(o.logoURI) ?? s(ext.image);
  out.websites = pick(o.website, ext.website, o.external_url, ext.external_url, o.homepage);
  out.twitter = pick(o.twitter, o.x, ext.twitter, ext.x);
  out.telegram = pick(o.telegram, ext.telegram);
  out.discord = pick(o.discord, ext.discord);
  return out;
}

/* ---------- Solana on-chain ---------- */

interface OnChainMeta {
  name: string | null;
  symbol: string | null;
  uri: string | null;
  image: string | null;
  externalUrl: string | null;
  /** Token-2022 additionalMetadata key/value pairs */
  extra: [string, string][];
}

const DasZ = z.object({
  content: z
    .object({
      json_uri: str,
      links: z.object({ image: str, external_url: str }).partial().nullish().catch(null),
      metadata: z.object({ name: str, symbol: str, description: str }).partial().nullish().catch(null),
    })
    .partial()
    .nullish(),
});

/** Helius DAS getAsset result → name / symbol / json_uri / image / external_url; null when there is no content. */
export function parseDasAsset(result: unknown): OnChainMeta | null {
  const r = DasZ.safeParse(result);
  if (!r.success || !r.data.content) return null;
  const c = r.data.content;
  return {
    name: c.metadata?.name ?? null,
    symbol: c.metadata?.symbol ?? null,
    uri: c.json_uri || null,
    image: c.links?.image || null,
    externalUrl: c.links?.external_url || null,
    extra: [],
  };
}

const MultiZ = z.object({ value: z.array(z.object({ owner: z.string(), data: z.unknown() }).nullable()) });

function base64Data(data: unknown): Buffer | null {
  const b64 = Array.isArray(data) && typeof data[0] === 'string' ? data[0] : typeof data === 'string' ? data : null;
  return b64 == null ? null : Buffer.from(b64, 'base64');
}

/** The Token-2022 tokenMetadata extension of a jsonParsed mint, if any. */
export function token2022Metadata(mintData: unknown): OnChainMeta | null {
  const exts = (mintData as { parsed?: { info?: { extensions?: unknown } } } | null)?.parsed?.info?.extensions;
  if (!Array.isArray(exts)) return null;
  const tm = exts.find(e => (e as { extension?: unknown })?.extension === 'tokenMetadata') as { state?: Record<string, unknown> } | undefined;
  const st = tm?.state;
  if (!st || typeof st !== 'object') return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const extra: [string, string][] = [];
  if (Array.isArray(st.additionalMetadata)) {
    for (const kv of st.additionalMetadata) {
      if (Array.isArray(kv) && typeof kv[0] === 'string' && typeof kv[1] === 'string') extra.push([kv[0], kv[1]]);
    }
  }
  return { name: s(st.name), symbol: s(st.symbol), uri: s(st.uri), image: null, externalUrl: null, extra };
}

export class TokenLinksAdapter implements TokenLinksSource {
  readonly configured = true;
  private readonly errors = new ErrorState('tokenLinks');
  private readonly rpcUrl: string;
  private readonly dasUrl: string | null;
  private readonly geckoBase: string;

  constructor(env: Pick<Env, 'RPC_SOLANA' | 'HELIUS_API_KEY'>, private readonly http: Http, opts: { geckoBase?: string } = {}) {
    this.rpcUrl = solanaRpcUrl(env);
    this.dasUrl = env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}` : null;
    this.geckoBase = (opts.geckoBase ?? GECKOTERMINAL_BASE).replace(/\/+$/, '');
  }

  get lastError() {
    return this.errors.lastError;
  }

  async gecko(chain: ChainKey, address: string): Promise<TokenLinks | null> {
    const network = GECKO_NETWORKS[chain];
    const a = address.trim();
    if (!network || !(RE_EVM_ADDRESS.test(a) || RE_SOL_ADDRESS.test(a) || RE_TRON_ADDRESS.test(a))) return null;
    try {
      const raw = await this.http.json(`${this.geckoBase}/networks/${network}/tokens/${encodeURIComponent(a)}/info`, {
        timeoutMs: GECKO_TIMEOUT_MS,
        maxBytes: 512 * 1024,
        headers: { accept: 'application/json;version=20230302' },
      });
      const out = parseGeckoInfo(raw);
      if (!out) this.errors.fail('gecko', new Error('unexpected response shape'));
      return out;
    } catch (e) {
      // an unknown token is not an error
      if (e instanceof HttpError && e.status === 404) return null;
      this.errors.fail('gecko', e);
      return null;
    }
  }

  async metadata(chain: ChainKey, address: string): Promise<TokenLinks | null> {
    const mint = address.trim();
    if (chain !== 'sol' || !RE_SOL_ADDRESS.test(mint)) return null;
    let meta: OnChainMeta | null = null;
    if (this.dasUrl) meta = await this.das(mint);
    if (!meta || (!meta.uri && !meta.image)) meta = (await this.onChain(mint)) ?? meta;
    if (!meta) return null;

    const out = emptyLinks();
    out.name = meta.name;
    out.symbol = meta.symbol;
    out.image = meta.image;
    const extra = Object.fromEntries(meta.extra.map(([k, v]) => [k.toLowerCase(), v]));
    const json = meta.uri ? await this.fetchJson(meta.uri) : null;
    if (json) {
      out.websites.push(...json.websites);
      out.twitter.push(...json.twitter);
      out.telegram.push(...json.telegram);
      out.discord.push(...json.discord);
      out.image ??= json.image;
      out.description = json.description;
      out.name ??= json.name;
      out.symbol ??= json.symbol;
    }
    if (meta.externalUrl) out.websites.push(meta.externalUrl);
    for (const k of ['website', 'external_url']) if (extra[k]) out.websites.push(extra[k]);
    for (const k of ['twitter', 'x']) if (extra[k]) out.twitter.push(extra[k]);
    if (extra.telegram) out.telegram.push(extra.telegram);
    if (extra.discord) out.discord.push(extra.discord);
    if (extra.image) out.image ??= extra.image;
    return out;
  }

  /** Helius DAS getAsset; null when it failed or has no content (the caller falls back to the accounts). */
  private async das(mint: string): Promise<OnChainMeta | null> {
    try {
      const res = await this.http.json<{ result?: unknown; error?: { message?: string } }>(this.dasUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'apecheck', method: 'getAsset', params: { id: mint } }),
        timeoutMs: RPC_TIMEOUT_MS,
        maxBytes: 1024 * 1024,
      });
      if (res?.error) throw new Error(res.error.message ?? 'DAS error');
      return parseDasAsset(res?.result);
    } catch (e) {
      this.errors.fail('das', e);
      return null;
    }
  }

  /** One getMultipleAccounts: the mint (Token-2022 tokenMetadata extension) and its Metaplex metadata account. */
  private async onChain(mint: string): Promise<OnChainMeta | null> {
    const pda = metadataPda(mint);
    if (!pda) return null;
    try {
      const raw = await jsonRpc(this.http, this.rpcUrl, 'getMultipleAccounts', [[mint, pda], { encoding: 'jsonParsed', commitment: 'confirmed' }], META_RPC_METHODS, {
        timeoutMs: this.rpcUrl === PUBLIC_SOLANA_RPC ? RPC_TIMEOUT_MS + 2_000 : RPC_TIMEOUT_MS,
        maxBytes: 1024 * 1024,
      });
      const [mintAcc, metaAcc] = MultiZ.parse(raw).value;
      const t22 = mintAcc?.owner === TOKEN_2022_PROGRAM ? token2022Metadata(mintAcc.data) : null;
      if (t22?.uri) return t22;
      const bytes = metaAcc ? base64Data(metaAcc.data) : null;
      const mp = bytes ? decodeMetaplexMetadata(bytes) : null;
      if (mp && mp.mint === mint) return { name: mp.name || null, symbol: mp.symbol || null, uri: mp.uri || null, image: null, externalUrl: null, extra: t22?.extra ?? [] };
      return t22;
    } catch (e) {
      this.errors.fail('metadata', e);
      return null;
    }
  }

  /** The metadata JSON at `uri` through the SSRF guard; null when unreadable. */
  private async fetchJson(uri: string): Promise<TokenLinks | null> {
    const url = gatewayUrl(uri);
    if (!url) return null;
    try {
      const res = await this.http.request(url, { guard: true, timeoutMs: META_JSON_TIMEOUT_MS, maxBytes: META_JSON_MAX_BYTES, headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' } });
      if (!res.ok) throw new HttpError(res.status, res.finalUrl, '', res.headers);
      if (res.truncated) throw new Error(`metadata JSON is larger than ${META_JSON_MAX_BYTES / 1024} KB`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        throw new Error('metadata is not JSON');
      }
      return parseMetadataJson(parsed);
    } catch (e) {
      this.errors.fail('metadataJson', e);
      return null;
    }
  }
}

export function createTokenLinks(env: Pick<Env, 'RPC_SOLANA' | 'HELIUS_API_KEY'>, http: Http, opts: { geckoBase?: string } = {}): TokenLinksAdapter {
  return new TokenLinksAdapter(env, http, opts);
}
