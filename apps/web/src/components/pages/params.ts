/**
 * URL search params of the /coins and /deployers pages. The filters live in the address bar so a filtered
 * view can be shared; the server render and the client both read them through these parsers, so an edited
 * or stale link falls back to the defaults instead of sending the API values it would reject.
 */
import { COIN_BANDS, isChainKey, type ChainKey, type CoinKey } from '@apecheck/core';

export type SearchParams = Record<string, string | string[] | undefined>;

/** The API caps `q` at 120 characters. */
export const Q_MAX = 120;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/* ---------- /coins ---------- */

export type CoinTab = CoinKey | 'all';
export interface CoinFilters {
  tab: CoinTab;
  chain: ChainKey | 'any';
  q: string;
}
export const COIN_DEFAULTS: CoinFilters = { tab: 'all', chain: 'any', q: '' };
/** GET /v1/coins has no cursor: ask for this many rows, then say "Showing n of total" */
export const COINS_LIMIT = 200;

const COIN_KEYS = new Set<string>(COIN_BANDS.map(b => b.key));

export function parseCoinFilters(sp: SearchParams | URLSearchParams): CoinFilters {
  const get = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) ?? '' : first(sp[k]));
  const tab = get('tab');
  const chain = get('chain');
  return {
    tab: COIN_KEYS.has(tab) ? (tab as CoinKey) : 'all',
    chain: isChainKey(chain) ? chain : 'any',
    q: get('q').trim().slice(0, Q_MAX),
  };
}

export function coinQuery(f: CoinFilters): string {
  const p = new URLSearchParams();
  if (f.tab !== 'all') p.set('tab', f.tab);
  if (f.chain !== 'any') p.set('chain', f.chain);
  if (f.q.trim()) p.set('q', f.q.trim());
  const s = p.toString();
  return s ? `?${s}` : '';
}

/* ---------- /deployers ---------- */

export type DeployerSort = 'real' | 'dead' | 'launched';
export interface DeployerFilters {
  chain: ChainKey | 'all';
  sort: DeployerSort;
  /** address of the open row (?focus=, linked from "Builders worth watching" and the report's deployer card) */
  focus: string | null;
}
export const DEPLOYER_DEFAULTS: DeployerFilters = { chain: 'all', sort: 'real', focus: null };
/** GET /v1/deployers has no cursor; its maximum */
export const DEPLOYERS_LIMIT = 500;

const SORTS = new Set<string>(['real', 'dead', 'launched']);
/** EVM, Solana and Tron addresses: base58 / hex, nothing else */
const ADDRESS_RE = /^[A-Za-z0-9]{20,64}$/;

export function parseDeployerFilters(sp: SearchParams | URLSearchParams): DeployerFilters {
  const get = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) ?? '' : first(sp[k]));
  const chain = get('chain');
  const sort = get('sort');
  const focus = get('focus').trim();
  return {
    chain: isChainKey(chain) ? chain : 'all',
    sort: SORTS.has(sort) ? (sort as DeployerSort) : 'real',
    focus: ADDRESS_RE.test(focus) ? focus : null,
  };
}

export function deployerQuery(f: DeployerFilters): string {
  const p = new URLSearchParams();
  if (f.chain !== 'all') p.set('chain', f.chain);
  if (f.sort !== 'real') p.set('sort', f.sort);
  if (f.focus) p.set('focus', f.focus);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Same address? EVM (0x…) addresses compare case-insensitively (checksummed vs lowercase); base58 is case-sensitive. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return /^0x/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}
