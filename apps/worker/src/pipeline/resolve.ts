/**
 * Stage A — resolve the target (no AI). Detect what was pasted, then fill the gaps:
 * contract → DexScreener token info → website + X handle; website → contract address and X handle from
 * the page HTML; X post → linked site and/or contract, read through X's free embed endpoints (x.getPost: never the
 * paid X API; X profiles are not read). runCheck then gives the Target row its canonical key and display fields
 * (saveTarget).
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
import { captureErrors, type DexTokenInfo } from '@apecheck/sources';
import type { CheckRun } from './context';
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

/**
 * Pick the project's own token from addresses found in text. A page can mention other tokens (USDC,
 * routers), so an address only counts when DexScreener knows it as a token, or when it is the only
 * (or the explicitly labelled) address and exists on-chain.
 */
export async function findCoin(run: CheckRun, text: string, signal: AbortSignal): Promise<FoundCoin | null> {
  const refs = extractRefs(text);
  const { dex, sol } = run.sources;
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
  if (!sure) return unconfirmed(tries.find(t => !common.has(t.addr))?.addr);
  if (sure.family === 'evm') {
    const det = await detectEvmChain(run, sure.addr);
    if (signal.aborted) return null;
    if (det.chain) return { chain: det.chain, ca: sure.addr.toLowerCase(), market: null };
    if (det.failed.length) down.add(det.failed.length === det.asked.length ? 'the chain RPCs' : `the ${listOf(det.failed.map(chainName), 'and')} RPC`);
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

export async function announceCoin(run: CheckRun, found: FoundCoin, where: 'page' | 'post', steps: StepSink, signal: AbortSignal) {
  if (signal.aborted) return;
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

/** Website + X handle from token metadata (DexScreener). */
async function fromTokenInfo(run: CheckRun, steps: StepSink) {
  const info = run.market;
  if (!info) return;
  // every write first: the steps below are the only awaits
  if (!run.handle) {
    const tw = info.socials.find(s => /twitter|^x$/i.test(s.type));
    const h = tw ? xHandleFromLinks([tw.url]) : null;
    if (h) run.handle = h;
  }
  if (!run.links.telegram) run.links.telegram = info.socials.find(s => /telegram/i.test(s.type))?.url ?? null;
  if (!run.links.discord) run.links.discord = info.socials.find(s => /discord/i.test(s.type))?.url ?? null;
  if (!run.siteUrl) {
    const site = projectSite(info.websites);
    if (site) {
      run.siteUrl = site;
      run.domain = normalizeDomain(new URL(site).hostname);
      await steps.step({ status: 'ok', text: `Website from token metadata: ${run.domain}`, source: 'DexScreener', url: site });
    } else if (run.kind === 'coin') {
      await steps.step({ status: 'info', text: 'No website in the token metadata', source: 'DexScreener' });
    }
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
    await steps.step({ status: 'warn', text: chainNotFoundText(address, detection ?? { chain: null, asked: [], failed: [] }), source: 'On-chain' });
    if (dexDown) await steps.step({ status: 'warn', text: 'DexScreener unavailable, no market data', source: 'DexScreener' });
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
  await fromTokenInfo(run, steps);
  if (run.siteUrl && !ctx.signal.aborted) await scanSiteHtml(run, steps, ctx);
  if (ctx.signal.aborted) return;
  if (!run.ticker && target?.ticker && run.kind === 'coin') run.ticker = target.ticker;
}

/** Links the later stages read, from what Stage A found (also after a Stage A timeout). */
export function finishResolve(run: CheckRun): void {
  if (run.siteUrl) run.links.site = run.siteUrl;
  if (run.handle) run.links.x = `https://x.com/${run.handle}`;
}
