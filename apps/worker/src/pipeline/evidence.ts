/**
 * Stage D — evidence (no AI): GitHub, the X account, and for coins ApeCheck's own facts: on-chain reads, the
 * deployer wallet and the other coins from it that ApeCheck has checked. Facts become signals only through ./signals
 * (core helpers + CONFIG/TUNING). A section ApeCheck could not check stays unknown (warn) and the log says
 * "not checked"; "unavailable" only names a source that failed (an RPC, Etherscan). The X account is only named:
 * its age, followers and bio are not read (that needs the paid X API), and it is not part of the score.
 */
import { CHAINS, deployerHistoryLine, deployerLine, short, type ChainKey, type Signal } from '@apecheck/core';
import { coinsByDeployer } from '@apecheck/db';
import { captureErrors, type CoinRawFacts, type RepoFacts, type XUser } from '@apecheck/sources';
import type { CheckRun } from './context';
import { announceCoin, findCoin } from './resolve';
import type { StepSink } from './steps';
import { coinSignals, gitFacts, gitSignal, worst } from './signals';
import type { StageCtx } from './stage';
import { within } from './stage';

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A name-search hit only counts when its owner or repo is clearly the project's. */
export function repoMatchesProject(r: RepoFacts, names: string[], domain: string | null): boolean {
  const [owner, repo] = r.fullName.split('/');
  const want = names.map(norm).filter(n => n.length >= 3);
  if (want.includes(norm(owner)) || want.includes(norm(repo))) return true;
  return !!domain && (r.description ?? '').toLowerCase().includes(domain.toLowerCase());
}

function projectNames(run: CheckRun): string[] {
  const out: string[] = [];
  if (run.domain) out.push(run.domain.split('.')[0]);
  if (run.handle) out.push(run.handle, run.handle.replace(/(labs|hq|_xyz|fi|app|io)$/i, ''));
  if (run.ticker) out.push(run.ticker);
  if (run.tokenName) out.push(run.tokenName);
  return [...new Set(out.filter(Boolean))];
}

interface GithubLookup {
  repos: RepoFacts[];
  /** GitHub answered with errors (down, rate limited, unreachable) and nothing was found */
  unavailable: boolean;
  viaSearch: boolean;
  /** no repo link anywhere and no project name to search for: GitHub was never asked */
  nothingToLookUp: boolean;
}

async function githubEvidence(run: CheckRun, signal: AbortSignal): Promise<GithubLookup> {
  const gh = run.sources.github;
  const urls = new Set<string>(run.links.github);
  for (const u of [run.xUser?.url, ...(run.xUser?.bioUrls ?? []), ...(run.post?.urls ?? [])]) {
    if (u && /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+/i.test(u)) urls.add(u.replace(/\/+$/, ''));
  }
  const names = projectNames(run);
  if (!urls.size && !names.length) return { repos: [], unavailable: false, viaSearch: false, nothingToLookUp: true };
  // errors of this check only (captureErrors), not another check's that runs at the same time
  const { value, errors } = await captureErrors(async () => {
    const byName = new Map<string, RepoFacts>();
    const lists = await Promise.all([...urls].slice(0, 4).map(u => within(gh.fromUrl(u), 15_000, [] as RepoFacts[])));
    for (const r of lists.flat()) byName.set(r.fullName.toLowerCase(), r);
    let viaSearch = false;
    if (!byName.size && !urls.size && !signal.aborted && names.length) {
      viaSearch = true;
      const hits = await within(gh.searchByName(names[0]), 15_000, [] as RepoFacts[]);
      for (const r of hits.filter(h => repoMatchesProject(h, names, run.domain))) byName.set(r.fullName.toLowerCase(), r);
    }
    return { repos: [...byName.values()], viaSearch };
  });
  return { ...value, unavailable: !value.repos.length && errors.length > 0, nothingToLookUp: false };
}

export function emptyFacts(run: CheckRun, error: string): CoinRawFacts {
  return {
    chain: run.chain!, address: run.ca!, token: null, deployer: null, bundle: null, holders: null, lp: null, authorities: null,
    market: null, stubbed: [], errors: [error],
  };
}

/**
 * coinFacts for the resolved coin, asked once per check and shared: runCheck starts it as soon as Stage A knows
 * the coin (it then runs alongside the browser), Stage D waits for it, and a Stage D that runs out of time can
 * still use an answer that is already there.
 */
export function coinFactsFor(run: CheckRun): Promise<CoinRawFacts> {
  const chain = run.chain!, ca = run.ca!;
  if (run.coinFacts && run.coinFacts.chain === chain && run.coinFacts.ca === ca) return run.coinFacts.promise;
  const entry: NonNullable<CheckRun['coinFacts']> = {
    chain,
    ca,
    raw: null,
    promise: within(run.sources.coinFacts(chain, ca), 30_000, null).then(raw => raw ?? emptyFacts(run, 'coinFacts: timeout')),
  };
  entry.promise.then(raw => { entry.raw = raw; }, () => undefined);
  run.coinFacts = entry;
  return entry.promise;
}

const pct = (n: number) => (Math.round(n * 10) / 10).toString();

/** A site was found but never read (didn't load, blocked our browser): what it links to is unknown. */
export const siteUnread = (run: CheckRun) => run.site.hasSite && !run.site.loaded;

/** "Solana RPC" / "Base RPC" / "TronGrid" when that chain's reads failed in coinFacts, else null. */
export function rpcOutage(chain: ChainKey, errors: string[]): string | null {
  const prefix = chain === 'sol' ? 'solana.' : chain === 'trx' ? 'tron.' : 'evm.';
  if (!errors.some(e => e.startsWith(prefix) && !e.startsWith('evm.creator'))) return null;
  return chain === 'sol' ? 'Solana RPC' : chain === 'trx' ? 'TronGrid' : `${CHAINS[chain].name} RPC`;
}

async function coinEvidence(run: CheckRun, steps: StepSink, signal: AbortSignal) {
  const raw = await coinFactsFor(run);
  // a Stage D that already ended must not change the run (the pipeline has gone on without it)
  if (signal.aborted) return;
  await applyCoinFacts(run, raw, steps, signal);
}

/**
 * Stage D ran out of time (or was skipped) before the coin was assessed: use coinFacts if they have already
 * answered, else score the coin as unknown (deployer 'mixed', every section warn), never as "no coin".
 */
export async function coinAfterStage(run: CheckRun): Promise<void> {
  if (!run.hasCoin() || run.coin) return;
  const raw = run.coinFacts && run.coinFacts.chain === run.chain && run.coinFacts.ca === run.ca ? run.coinFacts.raw : null;
  if (raw) {
    await applyCoinFacts(run, raw, run.steps, null);
    return;
  }
  const empty = emptyFacts(run, 'coinFacts: not gathered in time');
  await run.steps.step({ status: 'warn', text: 'Coin data not gathered in time; counts as unknown', source: 'On-chain' });
  run.coin = { raw: empty, signals: coinSignals(empty), evidence: {} };
}

async function applyCoinFacts(run: CheckRun, raw: CoinRawFacts, steps: StepSink, signal: AbortSignal | null) {
  for (const s of raw.stubbed) run.stubbed.add(s);
  if (raw.errors.length) run.log.info(`coin facts errors: ${raw.errors.join('; ')}`);
  if (!run.market && raw.market) {
    run.market = raw.market;
    if (raw.market.symbol && !run.ticker) run.ticker = raw.market.symbol.toUpperCase();
  }
  if (!run.ticker && raw.token?.symbol) run.ticker = raw.token.symbol.toUpperCase().slice(0, 20);
  const sig = coinSignals(raw);
  const evidence: NonNullable<CheckRun['coin']>['evidence'] = {};
  const rpc = rpcOutage(run.chain!, raw.errors);
  const unknown = (section: string) => {
    const line = sig.unknown.find(u => u.section === section)?.line ?? null;
    // the public fallback for these sections is the chain's RPC: say when it failed too
    if (line && rpc && (section === 'authorities' || (section === 'holders' && run.chain === 'sol'))) return `${line} (${rpc} unavailable)`;
    return line;
  };

  // deployer: the wallet, and its history from ApeCheck's own checks (shown, never scored: the signal stays unknown)
  const d = raw.deployer;
  if (d && sig.historyKnown) {
    const text = `Deployer: ${deployerLine({ record: sig.record, launched: d.launched!, dead: d.dead! })}`;
    const idx = await steps.step({ status: sig.deployer, text, source: d.source });
    evidence.deployer = { signal: sig.deployer, text, stepIdx: idx >= 0 ? idx : null };
  } else if (d) {
    const who = ` (${short(d.address)})`;
    const history = await within(coinsByDeployer(run.deps.prisma, { chain: run.chain!, address: d.address, excludeCa: run.ca }), 5_000, null);
    if (history) await steps.step({ status: sig.deployer, text: `Deployer history: ${deployerHistoryLine(history)}${who}`, source: 'ApeCheck' });
    else await steps.step({ status: 'warn', text: `Deployer history: not checked${who}` });
  } else {
    // EVM: the creator lookup (Etherscan) failed, or Etherscan has no creator on record ("No data found": an answer,
    // not an outage); Solana deployers are not looked up
    const etherscan = CHAINS[run.chain!].family === 'evm' && raw.errors.some(e => e.startsWith('evm.creator') && !/\bno (data|records?|result)\b/i.test(e));
    await steps.step({ status: 'warn', text: `Deployer: not checked${etherscan ? ' (Etherscan unavailable)' : ''}` });
  }

  // bundle
  if (raw.bundle) {
    const w = raw.bundle.wallets;
    const text = `Launch: ${pct(raw.bundle.pct)}% of supply bought by ${w != null ? `${w} bundled wallets` : 'bundled wallets'}`;
    const idx = await steps.step({ status: sig.bundle, text, source: raw.bundle.source });
    evidence.bundle = { signal: sig.bundle, text, stepIdx: idx >= 0 ? idx : null };
  } else {
    await steps.step({ status: 'warn', text: unknown('bundle')! });
  }

  // holders + liquidity
  const h = raw.holders;
  const lpPart = sig.lpText ? `liquidity ${sig.lpText}` : 'LP status not checked';
  if (h && h.top10Pct != null) {
    const dev = h.devHoldPct != null && h.devHoldPct >= 1 ? `, dev wallet ${pct(h.devHoldPct)}%` : '';
    const text = `Top 10 holders own ${pct(h.top10Pct)}%${dev}, ${lpPart}`;
    const status: Signal = sig.lpText ? worst(sig.holders, sig.lp) : sig.holders;
    const idx = await steps.step({ status, text, source: h.source });
    evidence.holders = { signal: sig.holders, text, stepIdx: idx >= 0 ? idx : null };
  } else {
    const text = sig.lpText ? `Liquidity ${sig.lpText}; holder share: not checked` : `${unknown('holders')!}, ${lpPart}`;
    await steps.step({ status: sig.lpText ? worst('warn', sig.lp) : 'warn', text, source: raw.lp?.source });
  }

  // authorities
  if (raw.authorities && raw.authorities.mintRenounced != null) {
    await steps.step({ status: sig.authorities, text: `Authorities: ${raw.authorities.text}`, source: raw.authorities.source });
  } else {
    await steps.step({ status: 'warn', text: unknown('authorities')!, source: 'On-chain' });
  }
  if (signal?.aborted) return;
  run.coin = { raw, signals: sig, evidence };
}

export async function evidenceStage(run: CheckRun, ctx: StageCtx): Promise<void> {
  const steps = run.steps.scoped(ctx.signal);
  const ghP = githubEvidence(run, ctx.signal);
  ghP.catch(() => undefined);
  // alongside GitHub, not after it (usually already started right after Stage A)
  if (run.hasCoin()) coinFactsFor(run).catch(() => undefined);

  // GitHub
  const gh = await ghP;
  if (gh.unavailable) {
    run.git.unknown = 'unavailable';
    await steps.step({ status: 'warn', text: 'GitHub unavailable, code not checked', source: 'GitHub' });
  } else if (gh.nothingToLookUp) {
    // never "no repository found" when GitHub wasn't asked: the code stays unknown (the judge decides, warn by default)
    run.git.unknown = 'nothing-to-look-up';
    await steps.step({ status: 'warn', text: 'No GitHub link or project name to look up, code not checked', source: 'GitHub' });
  } else {
    const claimsOpenSource = run.claims.some(c => c.kind === 'open_source') || /\bopen[- ]source\b/i.test(`${run.landing?.hero ?? ''} ${run.landing?.footer ?? ''}`);
    const launchAt = run.market?.pairCreatedAt ?? null;
    const facts = gh.repos.length ? gitFacts(gh.repos, launchAt) : gitFacts([], null);
    const g = gitSignal(facts, { claimsOpenSource, anchor: launchAt ? 'launch' : 'first' })!;
    const idx = await steps.step({ status: g.signal, text: `GitHub: ${g.text}`, source: 'GitHub', url: facts.originals[0]?.url ?? null });
    run.git = { facts, signal: { signal: g.signal, text: `GitHub: ${g.text}`, stepIdx: idx >= 0 ? idx : null }, plain: g.text, found: facts.originals.length > 0 };
  }
  run.steps.setProgress(0.7);

  // X account: named, never read (age and followers need the paid X API) and left out of the score
  if (!run.handle) {
    // the site is where an X link would be: when it couldn't be read, the account is unknown, not missing
    if (siteUnread(run)) await steps.step({ status: 'warn', text: "X account unknown (the site couldn't be read)", source: 'X' });
    else await steps.step({ status: 'info', text: 'No X account linked to the project', source: 'X' });
  } else {
    await steps.step({ status: 'info', text: `X account: @${run.handle}`, source: 'X', url: `https://x.com/${run.handle}` });
  }
  run.steps.setProgress(0.75);

  // a contract the rendered page shows (client-side apps don't have it in their HTML)
  if (!run.hasCoin() && run.landing && !ctx.signal.aborted) {
    const found = await findCoin(run, `${run.landing.hero}\n${run.landing.text}`, ctx.signal);
    if (found && !ctx.signal.aborted) await announceCoin(run, found, 'page', steps, ctx.signal);
  }
  if (ctx.signal.aborted) return;

  if (run.hasCoin()) {
    await coinEvidence(run, steps, ctx.signal);
  } else if (!run.coinAnnounced && run.kind !== 'coin') {
    // name only the places that were actually read
    const where = [run.site.loaded ? 'on the site' : null, run.post ? 'in the post' : null].filter(Boolean).join(' or ');
    const u = run.unconfirmedCoin;
    if (u) await steps.step({ status: 'warn', text: `Address ${short(u.address)} ${where || 'found'} couldn't be checked (${u.why})`, source: 'On-chain' });
    else await steps.step({ status: 'info', text: where ? `No contract found ${where}` : 'No contract to check' });
  }
  run.steps.setProgress(0.85);
}

