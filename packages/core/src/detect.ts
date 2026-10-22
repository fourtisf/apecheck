/**
 * Target detection. Same input rules as `detect()` in the prototype, plus the
 * parsing the pipeline and the X bot need (post ids, links/cashtags/CAs in text).
 * Pure functions: no network.
 */
import type { ChainKey } from './chains';

export type DetectKind = 'xpost' | 'evm' | 'tron' | 'sol' | 'site';

export type Detected =
  | { kind: 'xpost'; label: string; handle: string | null; postId: string | null }
  | { kind: 'evm'; label: string; address: string }
  | { kind: 'tron'; label: string; address: string }
  | { kind: 'sol'; label: string; address: string }
  | { kind: 'site'; label: string; domain: string; url: string }
  | { kind: 'bad' };

const B58 = '1-9A-HJ-NP-Za-km-z';
const RE_EVM = /^0x[a-fA-F0-9]{40}$/;
const RE_TRON = new RegExp(`^T[${B58}]{33}$`);
const RE_SOL = new RegExp(`^[${B58}]{32,44}$`);
const X_HOSTS = '(?:www\\.|mobile\\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\\.com';
const RE_X_STATUS = new RegExp(`(?:^|//|\\b)${X_HOSTS}/(?:i/web|([A-Za-z0-9_]{1,15}))/status(?:es)?/(\\d{1,25})`, 'i');
const RE_X_PROFILE = new RegExp(`(?:^|//|\\b)${X_HOSTS}/([A-Za-z0-9_]{1,15})/?(?:[?#].*)?$`, 'i');
const RE_SITE = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d{2,5})?(?:[/?#]\S*)?$/i;

/** Paths on x.com that are not user handles. */
export const X_RESERVED = new Set([
  'i', 'home', 'search', 'explore', 'intent', 'share', 'hashtag', 'settings', 'messages',
  'notifications', 'compose', 'login', 'logout', 'signup', 'tos', 'privacy', 'about', 'jobs',
]);

/** Hosts that are never a project's own site (socials, explorers, aggregators). */
export const NON_PROJECT_HOSTS = [
  'x.com', 'twitter.com', 't.co', 't.me', 'telegram.me', 'discord.gg', 'discord.com', 'youtube.com', 'youtu.be',
  'medium.com', 'linktr.ee', 'github.com', 'gitbook.io', 'dexscreener.com', 'dextools.io', 'birdeye.so',
  'pump.fun', 'solscan.io', 'etherscan.io', 'basescan.org', 'bscscan.com', 'arbiscan.io', 'tronscan.org', 'blockscout.com',
  'coingecko.com', 'coinmarketcap.com', 'geckoterminal.com', 'jup.ag', 'raydium.io', 'uniswap.org',
  'instagram.com', 'tiktok.com', 'facebook.com', 'reddit.com', 'apecheck.io',
];

/** A block-explorer transaction page (…/tx/0x…, Tronscan's #/transaction/…): it names a transaction, not a coin. */
const RE_TX_PATH = /\/(?:tx|txs|transaction|transactions)\/[^/?#]/i;

export function isNonProjectHost(domain: string): boolean {
  const d = domain.toLowerCase();
  return NON_PROJECT_HOSTS.some(h => d === h || d.endsWith('.' + h));
}

export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#:].*$/, '').replace(/^www\./, '').replace(/\.$/, '');
}

export function parseXPost(input: string): { handle: string | null; postId: string } | null {
  const m = input.match(RE_X_STATUS);
  if (!m) return null;
  const handle = m[1] && !X_RESERVED.has(m[1].toLowerCase()) ? m[1] : null;
  return { handle, postId: m[2] };
}

/** Same behaviour as the prototype's detect(), plus post ids and normalised addresses. */
export function detect(raw: string): Detected | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const post = parseXPost(v);
  if (post) return { kind: 'xpost', label: 'X post', handle: post.handle, postId: post.postId };
  const prof = v.match(RE_X_PROFILE);
  if (prof && !X_RESERVED.has(prof[1].toLowerCase())) return { kind: 'xpost', label: 'X account', handle: prof[1], postId: null };
  if (RE_EVM.test(v)) return { kind: 'evm', label: 'EVM CA', address: v.toLowerCase() };
  if (RE_TRON.test(v)) return { kind: 'tron', label: 'Tron CA', address: v };
  if (RE_SOL.test(v)) return { kind: 'sol', label: 'Solana CA', address: v };
  const m = v.match(RE_SITE);
  if (m) {
    const domain = m[1].toLowerCase().replace(/^www\./, '');
    const url = /^https?:\/\//i.test(v) ? v : 'https://' + v;
    // explorer / launchpad / chart links (pump.fun/coin/<mint>, dexscreener.com/base/0x…): check the coin, not the aggregator
    // (never from a transaction link: its 64-hex hash starts with 40 hex chars that are no address)
    if (isNonProjectHost(domain) && !RE_TX_PATH.test(v)) {
      const path = v.slice(v.indexOf(m[1]) + m[1].length);
      const evm = path.match(/(?<![0-9a-fA-F])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/);
      if (evm) return { kind: 'evm', label: 'EVM CA', address: evm[0].toLowerCase() };
      const tron = path.match(new RegExp(`T[${B58}]{33}(?![${B58}])`));
      if (tron) return { kind: 'tron', label: 'Tron CA', address: tron[0] };
      const sol = path.match(new RegExp(`(?<![${B58}])[${B58}]{32,44}(?![${B58}])`));
      if (sol && looksLikeSolMint(sol[0])) return { kind: 'sol', label: 'Solana CA', address: sol[0] };
    }
    return { kind: 'site', label: 'Website', domain, url };
  }
  return { kind: 'bad' };
}

/** Prototype chip text: "Auto" for empty, "Unknown" for bad, else the label. */
export function detectChipLabel(raw: string): { text: string; on: boolean } {
  const d = detect(raw);
  if (!d) return { text: 'Auto', on: false };
  if (d.kind === 'bad') return { text: 'Unknown', on: false };
  return { text: d.label, on: true };
}

export type TargetKindS = 'coin' | 'post' | 'site';

/** Kind of the Target row a detected input becomes before resolution. */
export function kindOf(d: Exclude<Detected, { kind: 'bad' }>): TargetKindS {
  return d.kind === 'site' ? 'site' : d.kind === 'xpost' ? 'post' : 'coin';
}

/**
 * Normalised lookup keys (Target.key):
 *   coin  → "ca:<chain>:<address>" ("ca:evm:<address>" before the EVM chain is known; EVM addresses lowercase)
 *   post  → "post:<tweetId>"
 *   x     → "x:<handle lowercase>"   (an X profile with no post)
 *   site  → "site:<domain>"
 */
export function targetKey(d: Exclude<Detected, { kind: 'bad' }>, chain?: ChainKey | null): string {
  switch (d.kind) {
    case 'evm': return `ca:${chain ?? 'evm'}:${d.address.toLowerCase()}`;
    case 'sol': return `ca:sol:${d.address}`;
    case 'tron': return `ca:trx:${d.address}`;
    case 'site': return `site:${d.domain}`;
    case 'xpost': return d.postId ? `post:${d.postId}` : `x:${(d.handle ?? '').toLowerCase()}`;
  }
}

export function coinKey(chain: ChainKey, address: string): string {
  return `ca:${chain}:${CHAINS_EVM_LOWER.has(chain) ? address.toLowerCase() : address}`;
}
const CHAINS_EVM_LOWER = new Set<ChainKey>(['eth', 'base', 'bnb', 'arb', 'rh']);

/* ---------- extraction from free text (posts, bios, page text) ---------- */

export interface ExtractedRefs {
  urls: string[];         // absolute http(s) URLs, deduped, in order
  domains: string[];      // project-looking domains (socials/explorers removed)
  cashtags: string[];     // without $, uppercase
  handles: string[];      // without @
  evm: string[];          // lowercase
  sol: string[];
  tron: string[];
  xPosts: { handle: string | null; postId: string }[];
}

const RE_URL = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const RE_BARE_DOMAIN = /(?:^|[\s(])((?:[a-z0-9-]+\.)+(?:xyz|app|ai|fi|io|fun|trade|finance|markets|com|org|net|gg|so|sh|co|dev|tech|network|money|exchange|world|lol|meme|bot|agent|wtf|cc|me|to|tv|club|site|online|pro|vip|one|zone|build|tools|capital|digital|cash|pay)\b)(?:\/[^\s]*)?/gi;
const RE_CASHTAG = /(?:^|[^A-Za-z0-9_$])\$([A-Za-z][A-Za-z0-9]{1,14})\b/g;
const RE_HANDLE = /(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{1,15})\b/g;
const RE_EVM_ANY = /\b0x[a-fA-F0-9]{40}\b/g;
const RE_TRON_ANY = new RegExp(`\\bT[${B58}]{33}\\b`, 'g');
const RE_SOL_ANY = new RegExp(`\\b[${B58}]{32,44}\\b`, 'g');

function uniq<T>(a: T[]): T[] { return [...new Set(a)]; }

/** A Solana-looking token must mix digits/cases like real base58 keys, not be an English word run. */
function looksLikeSolMint(s: string): boolean {
  return /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}

export function extractRefs(text: string): ExtractedRefs {
  const t = text ?? '';
  const urls = uniq((t.match(RE_URL) ?? []).map(u => u.replace(/[.,;:!?]+$/, '')));
  const xPosts = urls.map(u => parseXPost(u)).filter((p): p is { handle: string | null; postId: string } => !!p);
  const domainsFromUrls = urls.map(u => { try { return normalizeDomain(new URL(u).hostname); } catch { return ''; } });
  const bare: string[] = [];
  for (const m of t.matchAll(RE_BARE_DOMAIN)) bare.push(normalizeDomain(m[1]));
  const domains = uniq([...domainsFromUrls, ...bare].filter(d => d && d.includes('.') && !isNonProjectHost(d)));
  const cashtags = uniq([...t.matchAll(RE_CASHTAG)].map(m => m[1].toUpperCase()));
  const handles = uniq([...t.matchAll(RE_HANDLE)].map(m => m[1]).filter(h => !X_RESERVED.has(h.toLowerCase())));
  const evm = uniq((t.match(RE_EVM_ANY) ?? []).map(a => a.toLowerCase()));
  const tron = uniq(t.match(RE_TRON_ANY) ?? []);
  const sol = uniq((t.match(RE_SOL_ANY) ?? []).filter(s => !tron.includes(s) && !s.startsWith('0x') && looksLikeSolMint(s)));
  return { urls, domains, cashtags, handles, evm, sol, tron, xPosts };
}
