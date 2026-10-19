/**
 * Stage A — resolve the target (no AI). Detect what was pasted, then fill the gaps:
 * contract → DexScreener token info → website + X handle; website → contract address and X handle from
 * the page HTML; X post → linked site and/or contract (author profile as fallback). Finally the Target row
 * gets its canonical key and display fields.
 */
import {
  CHAINS,
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
import type { DexTokenInfo, XUser } from '@apecheck/sources';
import type { CheckRun } from './context';
import type { StageCtx } from './stage';
import { within } from './stage';

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

/**
 * Pick the project's own token from addresses found in text. A page can mention other tokens (USDC,
 * routers), so an address only counts when DexScreener knows it as a token, or when it is the only
 * (or the explicitly labelled) address and exists on-chain.
 */
export async function findCoin(run: CheckRun, text: string, signal: AbortSignal): Promise<FoundCoin | null> {
  const refs = extractRefs(text);
  const { dex, evm, sol } = run.sources;
  const rank = (list: string[]) => [...list].sort((a, b) => Number(labelled(text, b)) - Number(labelled(text, a))).slice(0, 3);
  const tries: { family: 'evm' | 'sol' | 'trx'; addr: string }[] = [
    ...rank(refs.evm).map(addr => ({ family: 'evm' as const, addr })),
    ...rank(refs.sol).map(addr => ({ family: 'sol' as const, addr })),
    ...rank(refs.tron).map(addr => ({ family: 'trx' as const, addr })),
  ].slice(0, 4);
  const common = new Set<string>();
  for (const t of tries) {
    if (signal.aborted) return null;
    const chain: ChainKey | null = t.family === 'sol' ? 'sol' : t.family === 'trx' ? 'trx' : null;
    const info = await within(dex.token(chain, t.addr), 10_000, null);
    // stablecoins / wrapped natives a page mentions for its pools are never the project's token
    if (info && COMMON_TOKENS.test(info.symbol ?? '')) {
      common.add(t.addr);
      continue;
    }
    if (info) return { chain: info.chain, ca: t.family === 'evm' ? t.addr.toLowerCase() : t.addr, market: info };
  }
  const total = refs.evm.length + refs.sol.length + refs.tron.length;
  const sure = tries.find(t => !common.has(t.addr) && (total === 1 || labelled(text, t.addr)));
  if (!sure || signal.aborted) return null;
  if (sure.family === 'evm') {
    const chain = await within(evm.detectChain(sure.addr), 15_000, null);
    return chain ? { chain, ca: sure.addr.toLowerCase(), market: null } : null;
  }
  if (sure.family === 'sol') {
    const mint = await within(sol.mintInfo(sure.addr), 10_000, null);
    return mint?.exists ? { chain: 'sol', ca: sure.addr, market: null } : null;
  }
  return { chain: 'trx', ca: sure.addr, market: null };
}

function applyMarket(run: CheckRun, info: DexTokenInfo) {
  run.market = info;
  if (info.symbol && !run.ticker) run.ticker = info.symbol.replace(/^\$/, '').toUpperCase().slice(0, 20);
  if (info.name && !run.tokenName) run.tokenName = info.name.slice(0, 80);
}

const chainName = (c: ChainKey) => CHAINS[c].name;

export async function announceCoin(run: CheckRun, found: FoundCoin, where: 'page' | 'post') {
  run.chain = found.chain;
  run.ca = found.ca;
  if (found.market) applyMarket(run, found.market);
  run.coinAnnounced = true;
  await run.steps.step({
    status: 'info',
    text: `Contract found ${where === 'page' ? 'on page' : 'in post'}: ${short(found.ca)} on ${chainName(found.chain)}`,
    caption: where === 'page' ? 'Reading the contract address' : null,
  });
}

/** Website + X handle from token metadata (DexScreener). */
async function fromTokenInfo(run: CheckRun) {
  const info = run.market;
  if (!info) return;
  if (!run.siteUrl) {
    const site = projectSite(info.websites);
    if (site) {
      run.siteUrl = site;
      run.domain = normalizeDomain(new URL(site).hostname);
      await run.steps.step({ status: 'ok', text: `Website from token metadata: ${run.domain}`, source: 'DexScreener', url: site });
    } else if (run.kind === 'coin') {
      await run.steps.step({ status: 'info', text: 'No website in the token metadata', source: 'DexScreener' });
    }
  }
  if (!run.handle) {
    const tw = info.socials.find(s => /twitter|^x$/i.test(s.type));
    const h = tw ? xHandleFromLinks([tw.url]) : null;
    if (h) run.handle = h;
  }
  if (!run.links.telegram) run.links.telegram = info.socials.find(s => /telegram/i.test(s.type))?.url ?? null;
  if (!run.links.discord) run.links.discord = info.socials.find(s => /discord/i.test(s.type))?.url ?? null;
}

async function resolveContract(run: CheckRun, kind: 'evm' | 'sol' | 'tron', address: string, presetChain: ChainKey | null) {
  const { dex, evm } = run.sources;
  let chain: ChainKey | null = kind === 'sol' ? 'sol' : kind === 'tron' ? 'trx' : presetChain;
  if (kind === 'evm' && !chain) chain = await within(evm.detectChain(address), 20_000, null);
  const info = await within(dex.token(chain, address), 10_000, null);
  if (!chain && info) chain = info.chain;
  run.ca = address;
  if (!chain) {
    await run.steps.step({ status: 'warn', text: `Contract ${short(address)} not found on Base, Ethereum, BNB Chain, Arbitrum or Robinhood Chain` });
    return;
  }
  run.chain = chain;
  run.coinAnnounced = true;
  await run.steps.step({ status: 'info', text: `Contract on ${chainName(chain)}: ${short(address)}`, source: info ? 'DexScreener' : 'On-chain' });
  if (info) applyMarket(run, info);
  else if (dex.lastError) await run.steps.step({ status: 'warn', text: 'DexScreener unavailable, no market data', source: 'DexScreener' });
  else await run.steps.step({ status: 'info', text: 'No trading pair found on DexScreener', source: 'DexScreener' });
}

async function resolvePost(run: CheckRun, postId: string, urlHandle: string | null, ctx: StageCtx) {
  const { x } = run.sources;
  const post = await within(x.getPost(postId), 12_000, null);
  if (!post) {
    if (urlHandle) run.handle = urlHandle;
    await run.steps.step({
      status: 'warn',
      text: x.configured ? "Couldn't read the post on X" : 'X unavailable, the post could not be read',
      source: 'X',
    });
    return;
  }
  run.post = post;
  run.handle = post.authorHandle ?? urlHandle;
  if (post.author) run.xUser = post.author;
  await run.steps.step({ status: 'info', text: `Reading post by @${run.handle ?? 'unknown'}`, source: 'X', url: `https://x.com/${run.handle ?? 'i'}/status/${post.id}` });
  const text = `${post.text}\n${post.urls.join('\n')}`;
  const refs = extractRefs(text);
  const site = projectSite([...post.urls, ...refs.urls, ...refs.domains]);
  if (site) {
    run.siteUrl = site;
    run.domain = normalizeDomain(new URL(site).hostname);
    await run.steps.step({ status: 'ok', text: `Found link in post: ${run.domain}`, url: site });
  }
  if (post.cashtags.length && !run.ticker) run.ticker = post.cashtags[0].replace(/^\$/, '').toUpperCase();
  else if (refs.cashtags.length && !run.ticker) run.ticker = refs.cashtags[0];
  if (refs.evm.length || refs.sol.length || refs.tron.length) {
    const found = await findCoin(run, text, ctx.signal);
    if (found) await announceCoin(run, found, 'post');
  }
  if (!run.siteUrl) await fromProfile(run, run.xUser ?? (run.handle ? await within(x.getUser(run.handle), 10_000, null) : null));
}

async function fromProfile(run: CheckRun, user: XUser | null) {
  if (!user) return;
  run.xUser = user;
  const site = projectSite([user.url, ...user.bioUrls, ...extractRefs(user.description ?? '').domains]);
  if (site && !run.siteUrl) {
    run.siteUrl = site;
    run.domain = normalizeDomain(new URL(site).hostname);
    await run.steps.step({ status: 'ok', text: `Website from @${user.handle}'s profile: ${run.domain}`, source: 'X', url: site });
  }
}

/** Contract address and X handle from the site's HTML (guarded fetch: the URL is user-supplied). */
async function scanSiteHtml(run: CheckRun, ctx: StageCtx) {
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
  const links = hrefsOf(html);
  if (!run.handle) run.handle = xHandleFromLinks(links);
  if (!run.hasCoin()) {
    const found = await findCoin(run, html.replace(/<[^>]+>/g, ' '), ctx.signal);
    if (found) await announceCoin(run, found, 'page');
  }
}

/** Canonical key + display fields; re-point the check when another Target already owns the key. */
export async function saveTarget(run: CheckRun): Promise<void> {
  const { prisma } = run.deps;
  const d = run.detected;
  if (!d) return;
  const key = run.kind === 'coin' && run.chain && run.ca ? coinKey(run.chain, run.ca) : targetKey(d, run.chain);
  const name =
    run.kind === 'coin' ? (run.ticker ? `$${run.ticker}` : short(run.ca ?? '')) : run.kind === 'post' ? (run.handle ? `@${run.handle}` : 'X post') : (run.domain ?? 'website');
  const data: Prisma.TargetUpdateInput = { kind: kindToDb(run.kind), name };
  if (run.chain) data.chain = chainToDb(run.chain);
  if (run.ca) data.ca = run.ca;
  if (run.domain) data.domain = run.domain;
  if (run.handle) data.handle = run.handle;
  if (run.ticker) data.ticker = run.ticker;

  const current = await prisma.target.findUnique({ where: { id: run.targetId }, select: { id: true, key: true } });
  if (!current) throw new UnrecoverableError('The target of this check no longer exists');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (key === current.key) {
      await prisma.target.update({ where: { id: current.id }, data });
      return;
    }
    const owner = await prisma.target.findUnique({ where: { key }, select: { id: true } });
    if (owner && owner.id !== current.id) {
      await prisma.$transaction([
        prisma.check.update({ where: { id: run.check.id }, data: { targetId: owner.id } }),
        prisma.target.update({ where: { id: owner.id }, data: { ...data, checkCount: { increment: 1 } } }),
        prisma.target.update({ where: { id: current.id }, data: { checkCount: { decrement: 1 } } }),
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
  const target = await run.deps.prisma.target.findUnique({ where: { id: run.targetId }, select: { chain: true, handle: true, ticker: true } });
  const presetChain = target?.chain ? (target.chain.toLowerCase() as ChainKey) : null;

  switch (d.kind) {
    case 'site':
      run.siteUrl = d.url;
      run.domain = d.domain;
      await run.steps.step({ status: 'info', text: `Target is a website: ${d.domain}`, url: d.url });
      break;
    case 'evm':
    case 'sol':
    case 'tron':
      await resolveContract(run, d.kind, d.address, d.kind === 'evm' ? presetChain : null);
      break;
    case 'xpost':
      if (d.postId) await resolvePost(run, d.postId, d.handle, ctx);
      else {
        run.handle = d.handle;
        const user = d.handle ? await within(run.sources.x.getUser(d.handle), 12_000, null) : null;
        await run.steps.step({
          status: user ? 'info' : 'warn',
          text: user ? `Reading @${user.handle}'s profile` : run.sources.x.configured ? `Couldn't read @${d.handle} on X` : 'X unavailable, the profile could not be read',
          source: 'X',
          url: d.handle ? `https://x.com/${d.handle}` : null,
        });
        await fromProfile(run, user);
        if (user && !run.hasCoin()) {
          const found = await findCoin(run, user.description ?? '', ctx.signal);
          if (found) await announceCoin(run, found, 'post');
        }
      }
      break;
  }

  // fill the gaps
  if (run.hasCoin() && !run.market) {
    const info = await within(run.sources.dex.token(run.chain, run.ca!), 10_000, null);
    if (info) applyMarket(run, info);
  }
  await fromTokenInfo(run);
  if (run.siteUrl && !ctx.signal.aborted) await scanSiteHtml(run, ctx);
  if (run.siteUrl) run.links.site = run.siteUrl;
  if (run.handle) run.links.x = `https://x.com/${run.handle}`;
  if (!run.ticker && target?.ticker && run.kind === 'coin') run.ticker = target.ticker;
  await saveTarget(run);
}
