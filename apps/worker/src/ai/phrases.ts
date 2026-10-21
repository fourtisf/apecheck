/**
 * Summary phrases in the prototype's voice (buildItem's prodS / gitS / coinS). Shared by the heuristic
 * judge and the pipeline, so a model-written summary and the stand-in read the same way.
 */
import type { Signal } from '@apecheck/core';
import type { CoinJudgeFacts, JudgeInput, ProductCauses, SignalEvidence } from './types';

export function productSentence(c: ProductCauses, p: { launch: SignalEvidence; flow: SignalEvidence }): string {
  if (c.noSite) return 'No website was found to test';
  if (c.unchecked) return 'The site could not be checked this time';
  if (c.notLoaded) return "The site doesn't load";
  if (p.launch.signal !== 'ok') {
    if (c.waitlist) return "The 'live' app is a waitlist";
    if (c.comingSoon) return "The app is still 'Coming soon'";
    if (c.launch404) return 'The app link leads to a 404 page';
    if (c.deadLaunch) return /^'.+' does nothing/.test(p.launch.text) ? p.launch.text.replace(/ when clicked\b.*$/, '') : "'Launch app' does nothing";
    if (c.noEntry) return 'There is no app to open on the site';
    return "The app didn't open";
  }
  if (p.flow.signal === 'ok') {
    // "end to end" only when a transaction was simulated; a signature request is as far as the flow was seen
    if (c.txReached && c.txSimulated === 'ok') return 'The app works end to end';
    if (c.mainSigned) return 'The app works up to the wallet signature';
    return 'The app works as far as it was tried';
  }
  if (p.flow.signal === 'warn') {
    if (c.txReached && c.txSimulated === 'skipped') return "The app reaches a transaction, but it couldn't be simulated";
    if (c.comingSoon) return "The app loads but the main flow stops at 'Coming soon'";
    if (c.waitlist) return 'The app loads but the main flow stops at a waitlist';
    if (c.needsFunds) return 'The app loads but the main flow needs funds to go further';
    if (c.mainPartial) return "The app loads but the main flow wasn't completed";
    return 'The app loads but the main flow could not be tried';
  }
  return 'The app loads but the main flow errors out';
}

export function gitSentence(signal: Signal, g: JudgeInput['git']): string {
  if (signal === 'ok') return 'code is public and active';
  if (signal === 'fail') return 'no code backs the open-source claim';
  if (g.burst) return 'the GitHub was pushed in one burst at launch';
  if (g.onlyForks) return 'the GitHub only has forks of other projects';
  if (g.found && g.stale) return 'the GitHub has gone quiet';
  if (g.found && g.thin) return 'the GitHub is thin';
  // GitHub was unreachable (or timed out): say so instead of implying a search came back empty
  if (g.unchecked) return 'the code could not be checked';
  return 'no public code was found';
}

export function coinSentence(c: CoinJudgeFacts): string {
  const s = c.signals;
  if (s.bundle === 'fail' && c.bundlePct != null) return `${c.bundlePct}% of supply was bundled at launch`;
  if (c.record === 'serial') return `Deployer has ${c.dead ?? 'many'} dead tokens behind it`;
  if (s.holders === 'fail' && c.top10Pct != null) return `Top 10 wallets hold ${c.top10Pct}%`;
  if (s.lp === 'fail') return 'Liquidity is unlocked';
  if (s.authorities === 'fail') return 'The mint is still active';
  // a warn can mean "measured and middling" or "not checked"; only the first is about the holders
  const measured =
    (s.bundle === 'warn' && c.bundlePct != null) ||
    (s.holders === 'warn' && (c.top10Pct != null || c.devHoldPct != null)) ||
    (c.record === 'mixed' && c.historyKnown);
  if (measured) return 'Holders are somewhat concentrated';
  const nothingKnown =
    !c.historyKnown && c.bundlePct == null && c.top10Pct == null && c.devHoldPct == null && c.lpText == null && c.authoritiesText == null;
  if (nothingKnown) return 'None of the coin data could be checked';
  if (s.bundle === 'warn' || s.holders === 'warn' || s.lp === 'warn' || s.authorities === 'warn' || c.record === 'mixed') {
    return 'Some of the coin data was not checked';
  }
  return 'Supply and liquidity look clean';
}
