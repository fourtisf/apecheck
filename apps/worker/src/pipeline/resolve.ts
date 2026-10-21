/**
 * Stage A — resolve the target (no AI). Detect what was pasted, then fill the gaps:
 * contract → website + X handle from DexScreener's token info, else the token's own metadata (Solana: Helius DAS or
 * the Metaplex account, then its JSON) and GeckoTerminal, read in parallel with DexScreener and never fatal;
 * website → contract address and X handle from the page HTML; X post → linked site and/or contract, read through
 * X's free embed endpoints (x.getPost: never the paid X API; X profiles are not read). runCheck then gives the
 * Target row its canonical key and display fields (saveTarget).
 *
 * A contract DexScreener lists only on a chain ApeCheck has no reads for (Sonic, Polygon, Avalanche…) is named as
 * such and never scored; a pasted one whose token info links the project's website becomes a check of that site.
 *
 * The stage can be abandoned at its timeout while a lookup is still running: every step goes through the
 * stage's scoped sink and nothing is written to the run once ctx.signal has aborted, so late work can't
 * change a check that has moved on (or already finished).
 */
import {
  CHAINS,
  EVM_DETECT_ORDER,
  X_RESERVED,
  chainToDb,
  coinKey,
  detect,
  extractRefs,
  isNonProjectHost,
  kindOf,
  kindToDb,
  normalizeDomain,
  short,
  targetKey,
  type ChainKey,
} from '@apecheck/core';
import type { Prisma } from '@apecheck/db';
import {
  captureErrors,
  linksFromDex,
  mergeTokenLinks,
  reportError,
  type DexOtherChainToken,
  type DexTokenInfo,
  type LinkSource,
  type TokenLinks,
  type XUser,
} from '@apecheck/sources';
import type { CheckRun, LinkReads } from './context';
import type { StageCtx } from './stage';
import { within } from './stage';
import { pgSafe } from './pgsafe';
import type { StepSink } from './steps';

export class UnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

/** First URL that looks like the project's own site, as an absolute URL. */
export function projectSite(urls: (string | null | undefined)[]): string | null {
  for (const raw of urls) {
    if (!raw) continue;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const host = normalizeDomain(u.hostname);
      if (!host.includes('.') || isNonProjectHost(host)) continue;
      return u.href;
    } catch {
      continue;
    }
  }
  return null;
}

const RE_X_LINK = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i;
const NOT_HANDLES = new Set([...X_RESERVED, 'intent', 'share', 'hashtag', 'search', 'i']);

/** The project's X handle from a list of links (profile links only, not share/intent links). */
export function xHandleFromLinks(urls: string[]): string | null {
  for (const u of urls) {
    const m = RE_X_LINK.exec(u.trim());
    if (m && !NOT_HANDLES.has(m[1].toLowerCase())) return m[1];
  }
  return null;
}

const HREF_RE = /href\s*=\s*["']([^"'<>\s]{4,500})["']/gi;
export const hrefsOf = (html: string) => [...html.matchAll(HREF_RE)].map(m => m[1]);

/** Addresses written right next to "CA" / "contract" / "token address" rank first. */
function labelled(text: string, addr: string): boolean {
  const i = text.indexOf(addr);
  if (i < 0) return false;
  return /\b(ca|contract|token address|token|mint|address)\b[^a-z0-9]{0,40}$/i.test(text.slice(Math.max(0, i - 60), i));
}

const COMMON_TOKENS = /^(USDC|USDT|USDBC|USDE|USDS|DAI|FDUSD|PYUSD|BUSD|WETH|ETH|WBNB|BNB|WSOL|SOL|WBTC|BTC|CBBTC|CBETH|STETH|WSTETH|WTRX|TRX)$/i;

export interface FoundCoin {
  chain: ChainKey;
  ca: string;
  market: DexTokenInfo | null;
}

/** A contract DexScreener lists only on a chain ApeCheck has no reads for (see announceOtherChain). */
export interface OtherChainCoin {
  ca: string;
  other: DexOtherChainToken;
}

/** DexScreener's listing of an address on chains ApeCheck has no reads for; `down` when DexScreener didn't answer. */
async function otherChainOf(run: CheckRun, address: string): Promise<{ other: DexOtherChainToken | null; down: boolean }> {
  const { dex } = run.sources;
  if (!dex.otherChain) return { other: null, down: false };
  const r = await within(captureErrors(() => dex.otherChain!(address)), 10_000, null);
  return { other: r?.value ?? null, down: !r || r.errors.length > 0 };
}

/**
 * Pick the project's own token from addresses found in text. A page can mention other tokens (USDC,
 * routers), so an address only counts when DexScreener knows it as a token, or when it is the only
 * (or the explicitly labelled) address and exists on-chain. Such an address that is on none of ApeCheck's chains
 * but that DexScreener lists on another one comes back as an OtherChainCoin.
 */
export async function findCoin(run: CheckRun, text: string, signal: AbortSignal): Promise<FoundCoin | OtherChainCoin | null> {
  const refs = extractRefs(text);
  const { dex, sol } = run.sources;
  // a contract already named as being on another chain is never looked up again, but it still counts: another
  // unlabelled address next to it (a treasury, a router) is not "the only address" on the page or in the post
  const named = run.otherChain?.address.toLowerCase() ?? null;
  // sources that failed while vetting the addresses: an address we couldn't vet is "unconfirmed", never "not found"
  const down = new Set<string>();
  const rank = (list: string[]) => [...list].sort((a, b) => Number(labelled(text, b)) - Number(labelled(text, a))).slice(0, 3);
  const tries: { family: 'evm' | 'sol' | 'trx'; addr: string }[] = [
    ...rank(refs.evm).map(addr => ({ family: 'evm' as const, addr })),
    ...rank(refs.sol).map(addr => ({ family: 'sol' as const, addr })),
    ...rank(refs.tron).map(addr => ({ family: 'trx' as const, addr })),
  ].slice(0, 4);
  const common = new Set<string>();
  for (const t of tries) {
    if (signal.aborted) return null;
    if (t.addr === named) continue;
    const chain: ChainKey | null = t.family === 'sol' ? 'sol' : t.family === 'trx' ? 'trx' : null;
    const r = await within(captureErrors(() => dex.token(chain, t.addr)), 10_000, null);
    if (signal.aborted) return null;
    const info = r?.value ?? null;
    if (!r || r.errors.length) down.add('DexScreener');
    // stablecoins / wrapped natives a page mentions for its pools are never the project's token
    if (info && COMMON_TOKENS.test(info.symbol ?? '')) {
      common.add(t.addr);
      continue;
    }
    if (info) return { chain: info.chain, ca: t.family === 'evm' ? t.addr.toLowerCase() : t.addr, market: info };
  }
  const total = refs.evm.length + refs.sol.length + refs.tron.length;
  const sure = tries.find(t => !common.has(t.addr) && (total === 1 || labelled(text, t.addr)));
  const unconfirmed = (addr: string | undefined) => {
    if (addr && down.size && !run.unconfirmedCoin && !signal.aborted) run.unconfirmedCoin = { address: addr, why: `${listOf([...down], 'and')} unavailable` };
    return null;
  };
  if (signal.aborted) return null;
  if (!sure) return unconfirmed(tries.find(t => !common.has(t.addr) && t.addr !== named)?.addr);
  // the project's coin is the one already named as being on another chain: nothing more to look up or say
  if (sure.addr === named) return null;
  if (sure.family === 'evm') {
    const det = await detectEvmChain(run, sure.addr);
    if (signal.aborted) return null;
    if (det.chain) return { chain: det.chain, ca: sure.addr.toLowerCase(), market: null };
    if (det.failed.length) down.add(det.failed.length === det.asked.length ? 'the chain RPCs' : `the ${listOf(det.failed.map(chainName), 'and')} RPC`);
    else if (!down.size) {
      // every chain ApeCheck reads said "no code": it may trade on one ApeCheck has no reads for
      const r = await otherChainOf(run, sure.addr);
      if (signal.aborted) return null;
      if (r.other) return { ca: sure.addr.toLowerCase(), other: r.other };
      if (r.down) down.add('DexScreener');
    }
    return unconfirmed(sure.addr);
  }
  if (sure.family === 'sol') {
    const r = await within(captureErrors(() => sol.mintInfo(sure.addr)), 10_000, null);
    if (signal.aborted) return null;
    if (r?.value?.exists) return { chain: 'sol', ca: sure.addr, market: null };
    if (!r || r.errors.length) down.add('the Solana RPC');
    return unconfirmed(sure.addr);
  }
  return { chain: 'trx', ca: sure.addr, market: null };
}

function applyMarket(run: CheckRun, info: DexTokenInfo) {
  run.market = info;
  if (info.symbol && !run.ticker) run.ticker = info.symbol.replace(/^\$/, '').toUpperCase().slice(0, 20);
  if (info.name && !run.tokenName) run.tokenName = info.name.slice(0, 80);
}

const chainName = (c: ChainKey) => CHAINS[c].name;

/**
 * A contract DexScreener lists only on a chain ApeCheck has no reads for (Sonic, Polygon, Avalanche…). The log names
 * that chain and says the coin isn't checked: there are no on-chain reads there, so no coin facts or score exist. For
 * a pasted contract or one in a post, its token info fills the project's website, X, Telegram and Discord that
 * nothing else gave (what fromTokenLinks does for a coin on a supported chain); a pasted contract whose website is
 * known then becomes a check of that site (saveTarget re-keys the Target to it). `failed`: chains whose RPC didn't
 * answer during detection.
 */
async function announceOtherChain(run: CheckRun, found: OtherChainCoin, where: 'contract' | 'page' | 'post', steps: StepSink, signal: AbortSignal, failed: ChainKey[] = []) {
  if (signal.aborted) return;
  const { ca, other } = found;
  // every write first: the steps below are the only awaits
  run.otherChain = { address: ca, chain: other.chainName, site: null };
  run.coinAnnounced = true;
  // the token's name only helps the GitHub search (never saved); its ticker is saved on the Target, see below
  if (other.name && !run.tokenName) run.tokenName = other.name.slice(0, 80);
  const parts: string[] = [];
  let site: string | null = null;
  if (where !== 'page') {
    const links = mergeTokenLinks([{ source: 'DexScreener', links: linksFromDex(other) }]);
    if (!run.siteUrl && links.website) {
      site = run.siteUrl = links.website.url;
      run.domain = normalizeDomain(new URL(site).hostname);
      parts.push(`website ${run.domain}`);
    }
    if (!run.handle && links.x) {
      run.handle = links.x.handle;
      parts.push(`X @${links.x.handle}`);
    }
    if (!run.links.telegram && links.telegram) run.links.telegram = links.telegram.url;
    if (!run.links.discord && links.discord) run.links.discord = links.discord.url;
  }
  const toSite = where === 'contract' && !!site;
  if (toSite) {
    // no coin to score: the check is of the project's site, and the contract isn't kept as the Target's coin
    run.kind = 'site';
    run.detected = { kind: 'site', label: 'Website', domain: run.domain!, url: site! };
    run.ca = null;
    run.otherChain.site = run.domain;
  } else if (where === 'contract' && other.symbol && !run.ticker) {
    // the check stays on the contract's own Target: the ticker is this token's. Never on a site or post Target, which
    // may hold the ticker of its own coin on a chain ApeCheck reads (saveTarget would write over it).
    run.ticker = other.symbol.replace(/^\$/, '').toUpperCase().slice(0, 20);
  }

  const lead = where === 'contract' ? `Contract on ${other.chainName}: ${short(ca)}` : `Contract found ${where === 'page' ? 'on page' : 'in post'}: ${short(ca)} on ${other.chainName}`;
  const pair = other.pairUrl && /^https:\/\/dexscreener\.com\//i.test(other.pairUrl) ? other.pairUrl : null;
  await steps.step({
    status: 'warn',
    text: `${lead} (on-chain reads aren't supported there yet, so the coin isn't checked)`,
    source: 'DexScreener',
    url: pair,
    caption: where === 'page' ? 'Reading the contract address' : null,
  });
  if (failed.length) await steps.step({ status: 'warn', text: `${listOf(failed.map(chainName), 'and')} RPC unavailable; DexScreener lists the contract on ${other.chainName}`, source: 'On-chain' });
  if (parts.length) await steps.step({ status: 'ok', text: `Token metadata: ${parts.join(', ')}`, source: 'DexScreener', url: site });
  if (where !== 'contract') return;
  if (toSite) await steps.step({ status: 'info', text: `Checking the project's website instead: ${run.domain}`, url: site });
  else await steps.step({ status: 'info', text: 'No website in the token metadata', source: 'DexScreener' });
}

export async function announceCoin(run: CheckRun, found: FoundCoin | OtherChainCoin, where: 'page' | 'post', steps: StepSink, signal: AbortSignal) {
  if (signal.aborted) return;
  if ('other' in found) {
    await announceOtherChain(run, found, where, steps, signal);
    return;
  }
  run.chain = found.chain;
  run.ca = found.ca;
  if (found.market) applyMarket(run, found.market);
  run.coinAnnounced = true;
  await steps.step({
    status: 'info',
    text: `Contract found ${where === 'page' ? 'on page' : 'in post'}: ${short(found.ca)} on ${chainName(found.chain)}`,
    caption: where === 'page' ? 'Reading the contract address' : null,
  });
}

/** Cap on each optional token-link read (token metadata incl. its JSON, GeckoTerminal). */
export const LINK_READ_MS = 14_000;

/**
 * Start the optional token-link reads for a coin check once (token metadata + GeckoTerminal, in parallel, each
 * capped at LINK_READ_MS). Never rejects: a failed or slow source answers null and its reason is kept in `errors`.
 */
export function startLinkReads(run: CheckRun, chain: ChainKey, ca: string): void {
  const src = run.sources.tokenLinks;
  if (!src || run.kind !== 'coin') return;
  if (run.linkReads && run.linkReads.chain === chain && run.linkReads.ca === ca) return;
  const read = async (fn: () => Promise<TokenLinks | null>, label: string): Promise<{ value: TokenLinks | null; errors: string[] }> => {
    const guarded = async () => {
      try {
        return await fn();
      } catch (e) {
        reportError(`${label}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    };
    const r = await within(captureErrors(guarded), LINK_READ_MS, null);
    return r ?? { value: null, errors: [`${label}: no answer within ${LINK_READ_MS / 1000} s`] };
  };
  const promise: Promise<LinkReads> = Promise.all([read(() => src.metadata(chain, ca), 'tokenLinks.metadata'), read(() => src.gecko(chain, ca), 'tokenLinks.gecko')]).then(
    ([m, g]) => ({ meta: m.value, gecko: g.value, errors: [...m.errors, ...g.errors] }),
    e => ({ meta: null, gecko: null, errors: [String(e)] }),
  );
  run.linkReads = { chain, ca, promise };
}

/**
 * Website, X handle, Telegram/Discord and the logo URL from the token's metadata: DexScreener's token info first,
 * then the token's own metadata ("On-chain"), then GeckoTerminal (per field, see mergeTokenLinks). Logs one
 * "Token metadata: website foo.xyz, X @foo" step per source that supplied something.
 */
async function fromTokenLinks(run: CheckRun, steps: StepSink, ctx: StageCtx) {
  if (run.kind === 'coin' && run.hasCoin()) startLinkReads(run, run.chain!, run.ca!);
  const reads = run.linkReads && run.linkReads.chain === run.chain && run.linkReads.ca === run.ca ? run.linkReads : null;
  const extra = reads ? await within(reads.promise, Math.max(0, ctx.deadline - Date.now() - 1_500), null) : null;
  if (ctx.signal.aborted) return;
  if (reads && !extra) run.log.info('token links: no answer before the resolve deadline');
  if (extra?.errors.length) run.log.info(`token links: ${extra.errors.join('; ')}`);
  if (!run.market && !extra) return;
  const merged = mergeTokenLinks([
    { source: 'DexScreener', links: linksFromDex(run.market) },
    { source: 'On-chain', links: extra?.meta },
    { source: 'GeckoTerminal', links: extra?.gecko },
  ]);
  run.tokenLinks = merged;
  if (!run.ticker && extra) {
    const sym = extra.meta?.symbol ?? extra.gecko?.symbol;
    if (sym) run.ticker = sym.replace(/^\$/, '').toUpperCase().slice(0, 20);
  }
  if (!run.tokenName && extra) {
    const name = extra.meta?.name ?? extra.gecko?.name;
    if (name) run.tokenName = name.slice(0, 80);
  }

  // every write first: the steps below are the only awaits
  const said = new Map<LinkSource, { parts: string[]; url: string | null }>();
  const say = (source: LinkSource, part: string, url: string | null = null) => {
    const cur = said.get(source) ?? { parts: [], url: null };
    cur.parts.push(part);
    cur.url ??= url;
    said.set(source, cur);
  };
  if (!run.siteUrl && merged.website) {
    run.siteUrl = merged.website.url;
    run.domain = normalizeDomain(new URL(merged.website.url).hostname);
    say(merged.website.source, `website ${run.domain}`, merged.website.url);
  }
  if (!run.handle && merged.x) {
    run.handle = merged.x.handle;
    say(merged.x.source, `X @${merged.x.handle}`);
  }
  if (!run.links.telegram && merged.telegram) run.links.telegram = merged.telegram.url;
  if (!run.links.discord && merged.discord) run.links.discord = merged.discord.url;

  for (const [source, { parts, url }] of said) await steps.step({ status: 'ok', text: `Token metadata: ${parts.join(', ')}`, source, url });
  if (!run.siteUrl && run.kind === 'coin') {
    await steps.step({ status: 'info', text: 'No website in the token metadata', source: extra ? null : 'DexScreener' });
  }
}

/** "A", "A or B", "A, B or C" */
export function listOf(items: string[], conj: 'or' | 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${conj} ${items[items.length - 1]}`;
}

export interface EvmDetection {
  chain: ChainKey | null;
  /** chains asked, in detection order (only those with an RPC) */
  asked: ChainKey[];
  /**
   * chains whose RPC failed or didn't answer; when a chain was found, only those before it in the detection
   * order (one of them could be the real chain)
   */
  failed: ChainKey[];
}

/** Which EVM chain has code at the address, and which RPCs could not answer (so "not found" is never claimed for them). */
export async function detectEvmChain(run: CheckRun, address: string): Promise<EvmDetection> {
  const { evm } = run.sources;
  const have = new Set(evm.chains());
  const asked = EVM_DETECT_ORDER.filter(c => have.has(c));
  const r = await within(captureErrors(() => evm.detectChain(address)), 20_000, null);
  if (!r) return { chain: null, asked, failed: asked };
  const before = r.value ? asked.slice(0, Math.max(0, asked.indexOf(r.value))) : asked;
  const failed = before.filter(c => r.errors.some(e => e.startsWith(`evm.getCode ${c}:`)));
  return { chain: r.value, asked, failed };
}

/** The log line for a contract whose chain wasn't found: "not found" only on chains that really answered. */
export function chainNotFoundText(address: string, d: EvmDetection): string {
  const names = (cs: ChainKey[]) => cs.map(chainName);
  const answered = d.asked.filter(c => !d.failed.includes(c));
  if (!d.asked.length) return `No EVM RPC configured; the chain of ${short(address)} is unknown`;
  if (!answered.length) return `Couldn't reach the ${listOf(names(d.asked), 'and')} RPCs, so the chain of ${short(address)} is unknown`;
  const notFound = `Contract ${short(address)} not found on ${listOf(names(answered), 'or')}`;
  return d.failed.length ? `${notFound}; ${listOf(names(d.failed), 'and')} RPC unavailable` : notFound;
}

async function resolveContract(run: CheckRun, kind: 'evm' | 'sol' | 'tron', address: string, presetChain: ChainKey | null, steps: StepSink, ctx: StageCtx) {
  const { dex } = run.sources;
  let chain: ChainKey | null = kind === 'sol' ? 'sol' : kind === 'tron' ? 'trx' : presetChain;
  const detection = kind === 'evm' && !chain ? await detectEvmChain(run, address) : null;
  if (ctx.signal.aborted) return;
  if (detection) chain = detection.chain;
  // the token's own metadata and GeckoTerminal, alongside DexScreener (their links count when DexScreener has none)
  if (chain) startLinkReads(run, chain, address);
  const lookup = (c: ChainKey | null) => within(captureErrors(() => dex.token(c, address)), 10_000, null);
  // An RPC earlier in the detection order didn't answer, so the code found on a later chain may not be the
  // deployment that trades: DexScreener (any chain) moves the check to an unanswered chain when its pair is there.
  const unanswered = detection?.chain ? detection.failed : [];
  let dexRes: Awaited<ReturnType<typeof lookup>> | undefined;
  if (unanswered.length) {
    const any = await lookup(null);
    if (ctx.signal.aborted) return;
    if (any?.value && unanswered.includes(any.value.chain)) chain = any.value.chain;
    // a pair on yet another chain says nothing about `chain`: ask for it below
    if (!any?.value || any.value.chain === chain) dexRes = any;
  }
  if (dexRes === undefined) {
    dexRes = await lookup(chain);
    if (ctx.signal.aborted) return;
  }
  const info = dexRes?.value ?? null;
  const dexDown = !dexRes || dexRes.errors.length > 0;
  if (!chain && info) chain = info.chain;
  run.ca = address;
  if (!chain) {
    // on none of ApeCheck's chains: DexScreener may list it on one ApeCheck has no reads for (Sonic, Polygon…)
    const elsewhere = kind === 'evm' && !dexDown ? await otherChainOf(run, address) : null;
    if (ctx.signal.aborted) return;
    if (elsewhere?.other) {
      await announceOtherChain(run, { ca: address, other: elsewhere.other }, 'contract', steps, ctx.signal, detection?.failed ?? []);
      return;
    }
    await steps.step({ status: 'warn', text: chainNotFoundText(address, detection ?? { chain: null, asked: [], failed: [] }), source: 'On-chain' });
    if (dexDown || elsewhere?.down) await steps.step({ status: 'warn', text: 'DexScreener unavailable, no market data', source: 'DexScreener' });
    return;
  }
  run.chain = chain;
  run.coinAnnounced = true;
  if (info) applyMarket(run, info);
  // Solana / Tron are known from the address format; EVM from the code found on-chain (or DexScreener's pair)
  const source = info ? 'DexScreener' : detection?.chain ? 'On-chain' : null;
  await steps.step({ status: 'info', text: `Contract on ${chainName(chain)}: ${short(address)}`, source });
  if (unanswered.length && chain === detection?.chain) {
    await steps.step({ status: 'warn', text: `${listOf(unanswered.map(chainName), 'and')} RPC unavailable; contract found on ${chainName(chain)}`, source: 'On-chain' });
  }
  if (info) return;
  if (dexDown) await steps.step({ status: 'warn', text: 'DexScreener unavailable, no market data', source: 'DexScreener' });
  else await steps.step({ status: 'info', text: 'No trading pair found on DexScreener', source: 'DexScreener' });
}

async function resolvePost(run: CheckRun, postId: string, urlHandle: string | null, steps: StepSink, ctx: StageCtx) {
  const { x } = run.sources;
  // free embed read (syndication, then oEmbed; 8 s each): no X API credits
  const post = await within(x.getPost(postId, urlHandle), 17_000, null);
  if (ctx.signal.aborted) return;
  if (!post) {
    if (urlHandle) run.handle = urlHandle;
    await steps.step({ status: 'warn', text: "Couldn't read the post on X", source: 'X' });
    return;
  }
  run.post = post;
  run.handle = post.authorHandle ?? urlHandle;
  if (post.author) run.xUser = post.author;
  await steps.step({ status: 'info', text: `Reading post by @${run.handle ?? 'unknown'}`, source: 'X', url: `https://x.com/${run.handle ?? 'i'}/status/${post.id}` });
  if (ctx.signal.aborted) return;
  const text = `${post.text}\n${post.urls.join('\n')}`;
  const refs = extractRefs(text);
  const site = projectSite([...post.urls, ...refs.urls, ...refs.domains]);
  if (site) {
    run.siteUrl = site;
    run.domain = normalizeDomain(new URL(site).hostname);
    await steps.step({ status: 'ok', text: `Found link in post: ${run.domain}`, url: site });
  }
  if (ctx.signal.aborted) return;
  if (post.cashtags.length && !run.ticker) run.ticker = post.cashtags[0].replace(/^\$/, '').toUpperCase();
  else if (refs.cashtags.length && !run.ticker) run.ticker = refs.cashtags[0];
  if (refs.evm.length || refs.sol.length || refs.tron.length) {
    const found = await findCoin(run, text, ctx.signal);
    if (found) await announceCoin(run, found, 'post', steps, ctx.signal);
  }
  // no fallback to the author's profile: checks never read X accounts (that needs the paid API)
}

/** Contract address and X handle from the site's HTML (guarded fetch: the URL is user-supplied). */
async function scanSiteHtml(run: CheckRun, steps: StepSink, ctx: StageCtx) {
  if (!run.siteUrl) return;
  let html = '';
  try {
    const res = await run.sources.http.request(run.siteUrl, { guard: true, timeoutMs: 10_000, maxBytes: 1_500_000 });
    if (!res.ok) return;
    html = res.text;
  } catch (e) {
    run.log.info(`site HTML not fetched: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (ctx.signal.aborted) return;
  const links = hrefsOf(html);
  if (!run.handle) run.handle = xHandleFromLinks(links);
  if (!run.hasCoin()) {
    const found = await findCoin(run, html.replace(/<[^>]+>/g, ' '), ctx.signal);
    if (found) await announceCoin(run, found, 'page', steps, ctx.signal);
  }
}

/** Canonical key + display fields; re-point the check when another Target already owns the key. */
export async function saveTarget(run: CheckRun): Promise<void> {
  const { prisma } = run.deps;
  const d = run.detected;
  if (!d) return;
  const key = run.kind === 'coin' && run.chain && run.ca ? coinKey(run.chain, run.ca) : targetKey(d, run.chain);
  const name =
    run.kind === 'coin' ? (run.ticker ? `$${run.ticker}` : short(run.ca ?? ('address' in d ? d.address : ''))) : run.kind === 'post' ? (run.handle ? `@${run.handle}` : 'X post') : (run.domain ?? 'website');
  const fields: Prisma.TargetUpdateInput = { kind: kindToDb(run.kind), name };
  if (run.chain) fields.chain = chainToDb(run.chain);
  if (run.ca) fields.ca = run.ca;
  if (run.domain) fields.domain = run.domain;
  if (run.handle) fields.handle = run.handle;
  if (run.ticker) fields.ticker = run.ticker;
  // names and tickers come from DexScreener / X: nothing Postgres refuses
  const data = pgSafe(fields);

  const current = await prisma.target.findUnique({ where: { id: run.targetId }, select: { id: true, key: true } });
  if (!current) throw new UnrecoverableError('The target of this check no longer exists');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (key === current.key) {
      await prisma.target.update({ where: { id: current.id }, data });
      return;
    }
    const owner = await prisma.target.findUnique({ where: { key }, select: { id: true } });
    if (owner && owner.id !== current.id) {
      // a private check never counted towards the public checkCount (db createCheck)
      const counted = !run.check.isPrivate;
      await prisma.$transaction([
        prisma.check.update({ where: { id: run.check.id }, data: { targetId: owner.id } }),
        prisma.target.update({ where: { id: owner.id }, data: counted ? { ...data, checkCount: { increment: 1 } } : data }),
        ...(counted ? [prisma.target.update({ where: { id: current.id }, data: { checkCount: { decrement: 1 } } })] : []),
      ]);
      run.targetId = owner.id;
      // the preliminary row (e.g. "ca:evm:…") is dropped once nothing points at it
      const left = await prisma.target.findUnique({ where: { id: current.id }, select: { _count: { select: { checks: true, watchers: true } } } });
      if (left && left._count.checks === 0 && left._count.watchers === 0) await prisma.target.delete({ where: { id: current.id } }).catch(() => undefined);
      return;
    }
    try {
      await prisma.target.update({ where: { id: current.id }, data: { ...data, key } });
      return;
    } catch (e) {
      // another check claimed the key in between: take the re-point path
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }
}

export async function resolveStage(run: CheckRun, ctx: StageCtx): Promise<void> {
  const d = detect(run.check.targetRaw);
  if (!d || d.kind === 'bad') throw new UnrecoverableError("Couldn't tell what this is: paste a contract address, an X post or a website");
  run.detected = d;
  run.kind = kindOf(d);
  const steps = run.steps.scoped(ctx.signal);
  const target = await run.deps.prisma.target.findUnique({ where: { id: run.targetId }, select: { chain: true, handle: true, ticker: true } });
  if (ctx.signal.aborted) return;
  const presetChain = target?.chain ? (target.chain.toLowerCase() as ChainKey) : null;

  switch (d.kind) {
    case 'site':
      run.siteUrl = d.url;
      run.domain = d.domain;
      await steps.step({ status: 'info', text: `Target is a website: ${d.domain}`, url: d.url });
      break;
    case 'evm':
    case 'sol':
    case 'tron':
      await resolveContract(run, d.kind, d.address, d.kind === 'evm' ? presetChain : null, steps, ctx);
      break;
    case 'xpost':
      if (d.postId) await resolvePost(run, d.postId, d.handle, steps, ctx);
      else {
        // an X profile: checks never read accounts (paid X API), so only the handle is known
        run.handle = d.handle;
        await steps.step({
          status: 'info',
          text: `Target is an X account: @${d.handle ?? 'unknown'} (profiles aren't read; paste a post or the website to check more)`,
          source: 'X',
          url: d.handle ? `https://x.com/${d.handle}` : null,
        });
      }
      break;
  }
  if (ctx.signal.aborted) return;

  // fill the gaps
  if (run.hasCoin() && !run.market) {
    const info = await within(run.sources.dex.token(run.chain, run.ca!), 10_000, null);
    if (ctx.signal.aborted) return;
    if (info) applyMarket(run, info);
  }
  await fromTokenLinks(run, steps, ctx);
  if (run.siteUrl && !ctx.signal.aborted) await scanSiteHtml(run, steps, ctx);
  if (ctx.signal.aborted) return;
  if (!run.ticker && target?.ticker && run.kind === 'coin') run.ticker = target.ticker;
}

/** Links the later stages read, from what Stage A found (also after a Stage A timeout). */
export function finishResolve(run: CheckRun): void {
  if (run.siteUrl) run.links.site = run.siteUrl;
  if (run.handle) run.links.x = `https://x.com/${run.handle}`;
}
