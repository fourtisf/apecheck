/**
 * Facts → ok | warn | fail. Pure functions so every rule is unit-tested. Product rules follow the task
 * spec (HANDOFF §4 Stage B); people rules use CONFIG.acctAgeDays / CONFIG.gitBurstHours and the TUNING
 * thresholds; coin signals come only from the core helpers (deployerRecord, bandSignal, holdersSignal,
 * lpSignal, authoritiesSignal). Unknown inputs never pass as ok.
 */
import {
  CONFIG,
  TUNING,
  authoritiesSignal,
  bandSignal,
  deployerRecord,
  deployerSignal,
  fmtAge,
  fmtCount,
  holdersSignal,
  lpSignal,
  type DeployerRecord,
  type Signal,
} from '@apecheck/core';
import type { CoinRawFacts, RepoFacts, XUser } from '@apecheck/sources';
import type { ProductCauses, SignalEvidence } from '../ai/types';
import { simSkipReason, type ExploreResult } from '../browser/agent';
import type { DocsResult } from '../browser/docs';
import { plural, sinceText } from './text';

/* ---------------- product (Stage B) ---------------- */

export interface SiteFacts {
  /** a website was found to open */
  hasSite: boolean;
  loaded: boolean;
  error: string | null;
  /** the copy claims a live product / app */
  claimsLive: boolean;
  /** the landing page itself is a waitlist / coming-soon splash */
  landingBlocked: 'waitlist' | 'coming_soon' | null;
  loadStepIdx: number | null;
  /** our browser failed (not the site): the product could not be judged */
  infraError?: string | null;
}

export interface DocsFacts {
  link: string | null;
  result: DocsResult | null;
  timedOut: boolean;
  stepIdx: number | null;
}

export interface ProductSignals {
  launch: SignalEvidence;
  flow: SignalEvidence;
  docs: SignalEvidence;
  /** evidence sentences as stored in Check.evidence (docs without the "Docs: " prefix) */
  plain: { launch: string; flow: string; docs: string };
  causes: ProductCauses;
}

// a step that was dropped (its stage had ended) has idx -1: never cite it
const ev = (signal: Signal, text: string, stepIdx: number | null = null): SignalEvidence => ({ signal, text, stepIdx: stepIdx != null && stepIdx >= 0 ? stepIdx : null });

/** The way into the app (not the main action inside it) ended at a 404, a dead button, an error, a waitlist or 'Coming soon'. */
function entryBlocked(x: ExploreResult): SignalEvidence | null {
  if (x.launch404) return ev('fail', x.launch404.text, x.launch404.stepIdx);
  if (x.deadLaunch) return ev('fail', x.deadLaunch.text, x.deadLaunch.stepIdx);
  if (x.errorScreen && !x.errorScreen.main) return ev('fail', x.errorScreen.text, x.errorScreen.stepIdx);
  if (x.waitlist && !x.waitlist.main) return ev('warn', x.waitlist.text, x.waitlist.stepIdx);
  if (x.comingSoon && !x.comingSoon.main) return ev('warn', x.comingSoon.text, x.comingSoon.stepIdx);
  return null;
}

/**
 * launch: ok when an app screen was reached (app route or link, an amount field, a transaction, a signature
 * from the main action). A wallet connect on a page that shows no app counts too, unless the site's app entry
 * leads to a 404, nothing, an error, a waitlist or 'Coming soon': a header "Connect wallet" from a template
 * doesn't make a waitlist site live.
 */
export function launchSignal(site: SiteFacts, x: ExploreResult | null): SignalEvidence {
  if (!site.hasSite) return ev('warn', 'No website was found to open');
  if (site.infraError && !site.loaded) return ev('warn', `The site could not be checked (${site.infraError})`, site.loadStepIdx);
  if (!site.loaded) return ev('fail', `The site didn't load (${site.error ?? 'no response'})`, site.loadStepIdx);
  if (site.landingBlocked === 'waitlist') return ev('warn', "The site is a waitlist page; there is no app to open", site.loadStepIdx);
  if (site.landingBlocked === 'coming_soon') return ev('warn', "The site is a 'Coming soon' page; there is no app to open", site.loadStepIdx);
  if (!x) return ev('warn', 'The app could not be tried in time');
  if (x.appReached) {
    const confirmed = x.appVia !== 'wallet' || !!x.tx?.reached || !!x.mainOk;
    const blocked = confirmed ? null : entryBlocked(x);
    if (blocked) return { ...blocked, text: `${blocked.text} (only the wallet connect works)` };
    const wallet = x.tx?.reached || x.actions.some(a => a.outcome === 'wallet');
    return ev('ok', wallet ? 'App opened and wallet connect works' : `App opened at ${shortHost(x.appUrl)}`, x.appStepIdx);
  }
  if (x.launch404) return ev('fail', x.launch404.text, x.launch404.stepIdx);
  if (x.deadLaunch) return ev('fail', x.deadLaunch.text, x.deadLaunch.stepIdx);
  if (x.errorScreen) return ev('fail', x.errorScreen.text, x.errorScreen.stepIdx);
  if (x.waitlist) return ev('warn', x.waitlist.text, x.waitlist.stepIdx);
  if (x.comingSoon) return ev('warn', x.comingSoon.text, x.comingSoon.stepIdx);
  if (!x.entryFound) {
    return site.claimsLive
      ? ev('warn', "The site says the product is live, but there is no 'Launch app' or similar button", site.loadStepIdx)
      : ev('warn', 'No app to open on the site', site.loadStepIdx);
  }
  return ev('warn', "The app entry didn't lead to a working app", lastIdx(x));
}

export function flowSignal(launch: SignalEvidence, x: ExploreResult | null): SignalEvidence {
  // the main flow can only be tried once the app opens (scoreNarrative applies the same rule)
  if (launch.signal !== 'ok' || !x) return ev(launch.signal, "Main flow couldn't be tried because the app didn't open", launch.stepIdx);
  const tx = x.tx;
  if (tx?.reached) {
    if (tx.simulated === 'ok') return ev('ok', 'Ran the main flow with a test wallet; the transaction simulates fine', tx.stepIdx);
    // not simulated (our RPC, an unsupported chain, out of time): reached, but not shown to work
    if (tx.simulated === 'skipped') return ev('warn', `Main flow reached a transaction; it couldn't be simulated (${simSkipReason(tx)})`, tx.stepIdx);
    if (tx.needsFunds) return ev('warn', 'Main flow reached a transaction, but it needs funds the test wallet does not have', tx.stepIdx);
    return ev('fail', `Main flow reached a transaction, but the simulation failed: ${tx.detail ?? 'reverted'}`, tx.stepIdx);
  }
  if (x.jsError) return ev('fail', x.jsError.text, x.jsError.stepIdx);
  if (x.errorScreen) return ev('fail', x.errorScreen.text, x.errorScreen.stepIdx);
  if (x.comingSoon) return ev('warn', "Main flow stops at a 'Coming soon' screen", x.comingSoon.stepIdx);
  if (x.waitlist) return ev('warn', 'Main flow stops at a waitlist form', x.waitlist.stepIdx);
  if (x.needsFunds) return ev('warn', x.needsFunds.text, x.needsFunds.stepIdx);
  if (x.mainOk) return ev('ok', `Ran the main flow with a test wallet: ${x.mainOk.text.replace(/^./, c => c.toLowerCase())}`, x.mainOk.stepIdx);
  if (x.mainPartial) {
    const k = x.mainPartial.kind;
    const text =
      k === 'modal' ? "The main action opened a dialog; the flow wasn't completed"
      : k === 'connect' ? 'The main action only made a wallet request (connect or network switch); no transaction or signature followed'
      : k === 'navigated' ? 'The main action opened another page; no transaction or signature followed'
      : 'The main action changed the page, but no transaction or signature followed';
    return ev('warn', text, x.mainPartial.stepIdx);
  }
  if (x.mainTried) return ev('warn', "The main action didn't respond", lastIdx(x));
  return ev('warn', 'Nothing to try in the app beyond the first screen', x.appStepIdx);
}

export function docsSignal(d: DocsFacts, hasSite: boolean, siteLoaded: boolean): { e: SignalEvidence; plain: string } {
  const mk = (signal: Signal, plain: string) => ({ e: ev(signal, `Docs: ${plain}`, d.stepIdx), plain });
  if (!hasSite || !siteLoaded) return mk('warn', 'no site to find docs on');
  if (!d.link) return mk('warn', 'no docs link on the site');
  const r = d.result;
  if (!r) return mk('warn', d.timedOut ? 'docs link timed out' : 'docs were not checked');
  if (r.pdf) return mk('warn', 'a single PDF document');
  if (!r.reachable) {
    if (r.status === 404 || r.status === 410) return mk('fail', 'link returns 404');
    return mk('fail', r.status ? `link returns HTTP ${r.status}` : `link doesn't load (${r.error ?? 'no response'})`);
  }
  const edited = r.lastUpdated ? `, last edited ${sinceText(r.lastUpdated)}` : '';
  if (r.pages >= TUNING.docsMinPages) {
    if (r.broken > 0) return mk('warn', `${plural(r.pages, 'page')}, ${plural(r.broken, 'broken link')}${edited}`);
    return mk('ok', `${plural(r.pages, 'page')}${edited}`);
  }
  if (r.pages <= 1) return mk('warn', r.technical ? `a single page${edited}` : 'a single page with no technical detail');
  return mk('warn', `${plural(r.pages, 'page')}${r.technical ? '' : ', little technical detail'}${edited}`);
}

function shortHost(url: string | null): string {
  if (!url) return 'its app page';
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/+$/, '');
  } catch {
    return url;
  }
}

function lastIdx(x: ExploreResult): number | null {
  const a = x.actions[x.actions.length - 1];
  return a && a.stepIdx >= 0 ? a.stepIdx : null;
}

export function productSignals(site: SiteFacts, x: ExploreResult | null, docs: DocsFacts): ProductSignals {
  const launch = launchSignal(site, x);
  const flow = flowSignal(launch, x);
  const d = docsSignal(docs, site.hasSite, site.loaded);
  // the causes follow the launch signal: a wallet connect that didn't count as the app doesn't hide a dead entry
  const launched = launch.signal === 'ok';
  const causes: ProductCauses = {
    noSite: !site.hasSite,
    unchecked: !!site.infraError && !site.loaded,
    notLoaded: site.hasSite && !site.loaded && !site.infraError,
    noEntry: !!x && !x.entryFound && !x.appReached,
    waitlist: site.landingBlocked === 'waitlist' || !!x?.waitlist,
    comingSoon: site.landingBlocked === 'coming_soon' || !!x?.comingSoon,
    deadLaunch: !!x?.deadLaunch && !launched,
    launch404: !!x?.launch404 && !launched,
    appReached: !!x?.appReached && launched,
    walletConnected: !!x?.actions.some(a => a.outcome === 'wallet') || !!x?.tx,
    txReached: !!x?.tx?.reached,
    txSimulated: x?.tx?.simulated ?? null,
    needsFunds: !!x?.needsFunds || !!x?.tx?.needsFunds,
    errorScreen: x?.errorScreen?.text ?? null,
    jsError: x?.jsError?.text ?? null,
    nothingToTry: launched && !!x?.appReached && !x.mainTried,
    mainSigned: !!x?.mainOk,
    mainPartial: !!x?.mainPartial,
  };
  return { launch, flow, docs: d.e, plain: { launch: launch.text, flow: flow.text, docs: d.plain }, causes };
}

/* ---------------- people (Stage D) ---------------- */

export interface GitFacts {
  repos: RepoFacts[];
  originals: RepoFacts[];
  totalCommits: number;
  contributors: number;
  firstCommit: string | null;
  lastCommit: string | null;
  burst: boolean;
  /** share of commits inside the burst window (0–1) */
  burstShare: number;
  stale: boolean;
  thin: boolean;
  onlyForks: boolean;
}

/**
 * Most commits within CONFIG.gitBurstHours of the anchor (token launch, else the first commit): a share above
 * TUNING.gitBurstShare, and only with at least TUNING.gitBurstMinCommits commits.
 */
export function gitFacts(repos: RepoFacts[], launchAt: string | null, now = Date.now()): GitFacts {
  const originals = repos.filter(r => !r.fork);
  const totalCommits = originals.reduce((s, r) => s + (r.commits || 0), 0);
  const firsts = originals.map(r => r.firstCommit).filter((d): d is string => !!d).sort();
  const lasts = originals.map(r => r.lastCommit ?? r.pushedAt).filter((d): d is string => !!d).sort();
  const firstCommit = firsts[0] ?? null;
  const lastCommit = lasts[lasts.length - 1] ?? null;
  const dates = originals.flatMap(r => r.recentCommitDates).map(d => Date.parse(d)).filter(Number.isFinite);
  const windowMs = CONFIG.gitBurstHours * 3_600_000;
  let inWindow = 0;
  const launch = launchAt ? Date.parse(launchAt) : NaN;
  if (Number.isFinite(launch)) inWindow = dates.filter(t => Math.abs(t - launch) <= windowMs).length;
  else if (firstCommit) {
    const f = Date.parse(firstCommit);
    inWindow = dates.filter(t => t - f >= 0 && t - f <= windowMs).length;
  }
  const denom = Math.max(totalCommits, dates.length);
  const burstShare = denom ? inWindow / denom : 0;
  // a burst only means something with more than a couple of commits
  const burst = denom >= TUNING.gitBurstMinCommits && burstShare > TUNING.gitBurstShare;
  const stale = !!lastCommit && now - Date.parse(lastCommit) > TUNING.gitStaleDays * 86_400_000;
  return {
    repos,
    originals,
    totalCommits,
    contributors: originals.reduce((m, r) => Math.max(m, r.contributors || 0), 0),
    firstCommit,
    lastCommit,
    burst,
    burstShare,
    stale,
    thin: totalCommits < TUNING.gitThinCommits,
    onlyForks: repos.length > 0 && originals.length === 0,
  };
}

/**
 * git: ok = real history (≥ TUNING.gitThinCommits, pushed within TUNING.gitStaleDays, no launch burst);
 * warn = burst / thin / stale / only forks / no repo and no open-source claim; fail = no repo but the
 * project says it is open source. null = GitHub could not be checked (the judge decides).
 */
export function gitSignal(g: GitFacts | null, opts: { claimsOpenSource: boolean; anchor: 'launch' | 'first'; now?: number }): { signal: Signal; text: string } | null {
  if (!g) return null;
  const now = opts.now ?? Date.now();
  if (!g.originals.length) {
    if (g.onlyForks) return { signal: 'warn', text: `only forks of other projects (${plural(g.repos.length, 'repo')})` };
    return opts.claimsOpenSource
      ? { signal: 'fail', text: 'no repository found, site says "open source"' }
      : { signal: 'warn', text: 'no repository found' };
  }
  const repos = plural(g.originals.length, 'repo');
  const commits = plural(g.totalCommits, 'commit');
  const pushed = g.lastCommit ? `last push ${sinceText(g.lastCommit, now)}` : 'no push date';
  if (g.burst) {
    const most = g.burstShare >= 0.99 ? 'all' : 'most';
    const anchor = opts.anchor === 'launch' ? 'launch' : 'the first commit';
    return { signal: 'warn', text: `${repos}, ${commits}, ${most} within ${CONFIG.gitBurstHours}h of ${anchor}` };
  }
  if (g.thin) return { signal: 'warn', text: `${repos}, ${commits}, ${pushed}` };
  if (g.stale) return { signal: 'warn', text: `${commits}, ${pushed}` };
  return { signal: 'ok', text: `${commits}, ${pushed}` };
}

/**
 * acct: ok ≥ CONFIG.acctAgeDays.ok days (warn instead when followers < TUNING.acctLowFollowers);
 * warn ≥ CONFIG.acctAgeDays.warn days; fail when younger. null when the account couldn't be read.
 */
export function acctSignal(u: XUser | null, renamed: number | null, now = Date.now()): { signal: Signal; text: string } | null {
  if (!u || !u.createdAt) return null;
  const days = (now - Date.parse(u.createdAt)) / 86_400_000;
  if (!Number.isFinite(days)) return null;
  const parts = [`@${u.handle}: ${fmtAge(u.createdAt, now)} old`];
  if (u.followers != null) parts.push(`${fmtCount(u.followers)} followers`);
  if (renamed != null) parts.push(renamed <= 0 ? 'never renamed' : renamed === 1 ? 'renamed once' : `renamed ${renamed} times`);
  const text = parts.join(', ');
  const few = u.followers != null && u.followers < TUNING.acctLowFollowers;
  if (days >= CONFIG.acctAgeDays.ok) return { signal: few ? 'warn' : 'ok', text };
  if (days >= CONFIG.acctAgeDays.warn) return { signal: 'warn', text };
  return { signal: 'fail', text };
}

/* ---------------- coin (Stage D) ---------------- */

export interface CoinSignals {
  record: DeployerRecord;
  historyKnown: boolean;
  deployer: Signal;
  bundle: Signal;
  holders: Signal;
  lp: Signal;
  authorities: Signal;
  /** sections ApeCheck could not check, with the log line saying so ("Bundle share: not checked") */
  unknown: { section: 'deployer' | 'bundle' | 'holders' | 'lp' | 'authorities'; line: string }[];
  /** "burned" | "locked:<days>" | "unlocked" | null (CoinFacts.lpStatus) */
  lpStatus: string | null;
  lpText: string | null;
}

export function coinSignals(f: CoinRawFacts): CoinSignals {
  const unknown: CoinSignals['unknown'] = [];
  const d = f.deployer;
  const historyKnown = !!d && d.launched != null && d.dead != null;
  const record: DeployerRecord = historyKnown ? deployerRecord(d!.launched!, d!.dead!) : 'mixed';
  if (!historyKnown) unknown.push({ section: 'deployer', line: 'Deployer history: not checked' });

  let bundle: Signal = 'warn';
  if (f.bundle && Number.isFinite(f.bundle.pct)) bundle = bandSignal(f.bundle.pct, CONFIG.bundlePct);
  else unknown.push({ section: 'bundle', line: 'Bundle share: not checked' });

  let holders: Signal = 'warn';
  const h = f.holders;
  if (h && h.top10Pct != null && h.devHoldPct != null) holders = holdersSignal(h.top10Pct, h.devHoldPct);
  else if (h && h.top10Pct != null) holders = bandSignal(h.top10Pct, CONFIG.top10Pct);
  else unknown.push({ section: 'holders', line: 'Holder share: not checked' });

  let lp: Signal = 'warn';
  let lpStatus: string | null = null;
  let lpText: string | null = null;
  if (f.lp) {
    lp = lpSignal(f.lp.status, f.lp.lockedDays ?? 0);
    lpStatus = f.lp.status === 'locked' ? (f.lp.lockedDays != null ? `locked:${Math.round(f.lp.lockedDays)}` : 'locked') : f.lp.status;
    lpText = f.lp.status === 'locked' ? (f.lp.lockedDays != null ? `locked ${Math.round(f.lp.lockedDays)} days` : 'locked') : f.lp.status;
  } else unknown.push({ section: 'lp', line: 'LP status: not checked' });

  let authorities: Signal = 'warn';
  const a = f.authorities;
  if (a && a.mintRenounced != null) authorities = authoritiesSignal(a.mintRenounced, a.freezeActive ?? false);
  else unknown.push({ section: 'authorities', line: 'Mint and freeze authorities unknown' });

  return { record, historyKnown, deployer: deployerSignal(record), bundle, holders, lp, authorities, unknown, lpStatus, lpText };
}

/** Worst of a list of signals (for steps that cover two facts). */
export function worst(...s: Signal[]): Signal {
  return s.includes('fail') ? 'fail' : s.includes('warn') ? 'warn' : 'ok';
}
