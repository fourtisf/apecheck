/**
 * Stage D — evidence (no AI): GitHub, the X account, and for coins the Fourtis / on-chain facts.
 * Facts become signals only through ./signals (core helpers + CONFIG/TUNING). A source that is not
 * available leaves its signal unknown and the log says which source was missing.
 */
import { deployerLine, short, type Signal } from '@apecheck/core';
import type { CoinRawFacts, RepoFacts, XUser } from '@apecheck/sources';
import type { CheckRun } from './context';
import { announceCoin, findCoin } from './resolve';
import { acctSignal, coinSignals, gitFacts, gitSignal, worst } from './signals';
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

async function githubEvidence(run: CheckRun, signal: AbortSignal): Promise<{ repos: RepoFacts[]; unavailable: boolean; viaSearch: boolean }> {
  const gh = run.sources.github;
  const before = gh.lastError ?? null;
  const urls = new Set<string>(run.links.github);
  for (const u of [run.xUser?.url, ...(run.xUser?.bioUrls ?? []), ...(run.post?.urls ?? [])]) {
    if (u && /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+/i.test(u)) urls.add(u.replace(/\/+$/, ''));
  }
  const byName = new Map<string, RepoFacts>();
  const lists = await Promise.all([...urls].slice(0, 4).map(u => within(gh.fromUrl(u), 15_000, [] as RepoFacts[])));
  for (const r of lists.flat()) byName.set(r.fullName.toLowerCase(), r);
  let viaSearch = false;
  if (!byName.size && !urls.size && !signal.aborted) {
    const names = projectNames(run);
    if (names.length) {
      viaSearch = true;
      const hits = await within(gh.searchByName(names[0]), 15_000, [] as RepoFacts[]);
      for (const r of hits.filter(h => repoMatchesProject(h, names, run.domain))) byName.set(r.fullName.toLowerCase(), r);
    }
  }
  const repos = [...byName.values()];
  const after = gh.lastError ?? null;
  return { repos, unavailable: !repos.length && after != null && after !== before, viaSearch };
}

async function xAccount(run: CheckRun): Promise<{ user: XUser | null; renamed: number | null }> {
  const handle = run.handle;
  if (!handle) return { user: null, renamed: null };
  const { x } = run.sources;
  const user = run.xUser && run.xUser.handle.toLowerCase() === handle.toLowerCase() ? run.xUser : await within(x.getUser(handle), 10_000, null);
  const renamed = user ? await within(x.renameCount(handle), 5_000, null) : null;
  return { user, renamed };
}

function emptyFacts(run: CheckRun, error: string): CoinRawFacts {
  return {
    chain: run.chain!, address: run.ca!, token: null, deployer: null, bundle: null, holders: null, lp: null, authorities: null,
    market: null, stubbed: [], errors: [error],
  };
}

const pct = (n: number) => (Math.round(n * 10) / 10).toString();

async function coinEvidence(run: CheckRun, steps: ReturnType<CheckRun['steps']['scoped']>) {
  const raw = (await within(run.sources.coinFacts(run.chain!, run.ca!), 30_000, null)) ?? emptyFacts(run, 'coinFacts: timeout');
  for (const s of raw.stubbed) run.stubbed.add(s);
  if (raw.errors.length) run.log.info(`coin facts errors: ${raw.errors.join('; ')}`);
  if (!run.market && raw.market) {
    run.market = raw.market;
    if (raw.market.symbol && !run.ticker) run.ticker = raw.market.symbol.toUpperCase();
  }
  if (!run.ticker && raw.token?.symbol) run.ticker = raw.token.symbol.toUpperCase().slice(0, 20);
  const sig = coinSignals(raw);
  const evidence: NonNullable<CheckRun['coin']>['evidence'] = {};
  const unknown = (section: string) => sig.unknown.find(u => u.section === section)?.line ?? null;

  // deployer
  const d = raw.deployer;
  if (d && sig.historyKnown) {
    const text = `Deployer: ${deployerLine({ record: sig.record, launched: d.launched!, dead: d.dead!, fundedFrom: d.fundedFrom })}`;
    const idx = await steps.step({ status: sig.deployer, text, source: d.source });
    evidence.deployer = { signal: sig.deployer, text, stepIdx: idx >= 0 ? idx : null };
  } else {
    const who = d ? ` (${short(d.address)})` : '';
    await steps.step({ status: 'warn', text: `${unknown('deployer')}${who}`, source: 'DevRadar' });
  }

  // bundle
  if (raw.bundle) {
    const w = raw.bundle.wallets;
    const text = `Launch: ${pct(raw.bundle.pct)}% of supply bought by ${w != null ? `${w} bundled wallets` : 'bundled wallets'}`;
    const idx = await steps.step({ status: sig.bundle, text, source: raw.bundle.source });
    evidence.bundle = { signal: sig.bundle, text, stepIdx: idx >= 0 ? idx : null };
  } else {
    await steps.step({ status: 'warn', text: unknown('bundle')!, source: 'BundleScan' });
  }

  // holders + liquidity
  const h = raw.holders;
  const lpPart = sig.lpText ? `liquidity ${sig.lpText}` : 'LP status unknown';
  if (h && h.top10Pct != null) {
    const dev = h.devHoldPct != null && h.devHoldPct >= 1 ? `, dev wallet ${pct(h.devHoldPct)}%` : '';
    const text = `Top 10 holders own ${pct(h.top10Pct)}%${dev}, ${lpPart}`;
    const status: Signal = sig.lpText ? worst(sig.holders, sig.lp) : sig.holders;
    const idx = await steps.step({ status, text, source: h.source });
    evidence.holders = { signal: sig.holders, text, stepIdx: idx >= 0 ? idx : null };
  } else {
    const text = sig.lpText ? `Liquidity ${sig.lpText}; holder share unknown (WhaleFlow unavailable)` : unknown('holders')!;
    await steps.step({ status: sig.lpText ? worst('warn', sig.lp) : 'warn', text, source: raw.lp?.source ?? 'WhaleFlow' });
  }

  // authorities
  if (raw.authorities && raw.authorities.mintRenounced != null) {
    await steps.step({ status: sig.authorities, text: `Authorities: ${raw.authorities.text}`, source: raw.authorities.source });
  } else {
    await steps.step({ status: 'warn', text: unknown('authorities')!, source: 'On-chain' });
  }
  run.coin = { raw, signals: sig, evidence };
}

export async function evidenceStage(run: CheckRun, ctx: StageCtx): Promise<void> {
  const steps = run.steps.scoped(ctx.signal);
  const ghP = githubEvidence(run, ctx.signal);
  const xP = xAccount(run);
  ghP.catch(() => undefined);
  xP.catch(() => undefined);

  // GitHub
  const gh = await ghP;
  if (gh.unavailable) {
    await steps.step({ status: 'warn', text: 'GitHub unavailable, code not checked', source: 'GitHub' });
  } else {
    const claimsOpenSource = run.claims.some(c => c.kind === 'open_source') || /\bopen[- ]source\b/i.test(`${run.landing?.hero ?? ''} ${run.landing?.footer ?? ''}`);
    const launchAt = run.market?.pairCreatedAt ?? null;
    const facts = gh.repos.length ? gitFacts(gh.repos, launchAt) : gitFacts([], null);
    const g = gitSignal(facts, { claimsOpenSource, anchor: launchAt ? 'launch' : 'first' })!;
    const idx = await steps.step({ status: g.signal, text: `GitHub: ${g.text}`, source: 'GitHub', url: facts.originals[0]?.url ?? null });
    run.git = { facts, signal: { signal: g.signal, text: `GitHub: ${g.text}`, stepIdx: idx >= 0 ? idx : null }, plain: g.text, found: facts.originals.length > 0 };
  }
  run.steps.setProgress(0.7);

  // X account
  const { user, renamed } = await xP;
  if (!run.handle) {
    await steps.step({ status: 'info', text: 'No X account linked to the project', source: 'X' });
  } else if (!user) {
    await steps.step({ status: 'warn', text: run.sources.x.configured ? `Couldn't read @${run.handle} on X` : 'X unavailable, account age unknown', source: 'X' });
  } else {
    run.xUser = user;
    const a = acctSignal(user, renamed);
    if (a) {
      const idx = await steps.step({ status: a.signal, text: a.text, source: 'X', url: `https://x.com/${user.handle}` });
      run.acct = { signal: { signal: a.signal, text: a.text, stepIdx: idx >= 0 ? idx : null }, plain: a.text, renamed };
    } else {
      await steps.step({ status: 'warn', text: `@${user.handle}: account age unknown`, source: 'X' });
    }
  }
  run.steps.setProgress(0.75);

  // a contract the rendered page shows (client-side apps don't have it in their HTML)
  if (!run.hasCoin() && run.landing && !ctx.signal.aborted) {
    const found = await findCoin(run, `${run.landing.hero}\n${run.landing.text}`, ctx.signal);
    if (found) await announceCoin(run, found, 'page');
  }

  if (run.hasCoin()) {
    await coinEvidence(run, steps);
  } else if (!run.coinAnnounced) {
    await steps.step({ status: 'info', text: run.post ? 'No contract found on the site or in the post' : 'No contract found on the site' });
  }
  run.steps.setProgress(0.85);
}

