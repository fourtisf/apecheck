/**
 * "Not enough to check". A check that could test nothing about the project ends FAILED with a plain reason instead of
 * a score: with nothing tested every signal is unknown, and unknowns add up to the neutral middle, so an X profile
 * with no links and a contract on a chain ApeCheck doesn't support would both read "PARTLY REAL (50/100)", a verdict
 * nothing supports.
 *
 * Nothing was tested when, from the run's own evidence, all of these hold:
 *  - no site answered: none was found, it blocks automated browsers, or our own browser failed on it or never got to
 *    it (siteAnswered). A site that answered but didn't load (an error, no response: a dead project site) is a result
 *    and is scored as not loading;
 *  - no docs were read (run.docs.result);
 *  - no GitHub repo was found: none linked, and a search by the project's name found none, forks included
 *    (run.git.facts.repos);
 *  - no coin fact was read: no coin on a supported chain, or one whose every scored section (deployer history, bundle,
 *    holders, LP, authorities) is unknown (coinRead);
 *  - no claim was confirmed or contradicted: every claim, if any, ends "not seen".
 * Anything tested is scored as before: a site that loaded but has no repo, a dead site, a repo without a site, a coin
 * with one fact read, a claim contradicted because the site that says it is live didn't load.
 *
 * Two kinds of nothing, told apart by whether every lookup that could have found something answered:
 *  - all answered: "Not enough to check: <the lookups that ran, for this kind of target, and what they found>." (core
 *    NOT_ENOUGH_PREFIX). It names nothing that wasn't looked up: an X profile is never read, so its reason says so. An
 *    answer, not an outage: the bot posts the reason, the report shows it, nobody is told to try again;
 *  - one didn't (Stage A or D cut short, GitHub down or too slow, the post unreadable, an address the RPCs or
 *    DexScreener couldn't vet, the coin's facts unread because its RPC didn't answer, our browser failing on the site
 *    or never getting to it): "Nothing about <target> could be checked: <which>". The nothing is ours, so it is a
 *    failed run like any other (the bot and the report say to try again).
 */
import { CHAINS, NOT_ENOUGH_PREFIX, clipSentence, short, type ClaimStatus } from '@apecheck/core';
import type { CheckRun } from './context';
import { rpcOutage } from './evidence';
import { finalJudgement } from './judge';
import { listOf } from './resolve';
import type { CoinSignals } from './signals';

/** Check.error is shown up to 200 characters (apps/api mappers). */
const MAX_LEN = 200;

/** What an X profile's reason ends with: the bot reads posts, never profiles (that needs the paid X API). */
const PROFILE_HINT = 'Tag me under a post with its link or contract.';

/** The coin's scored sections: unread ones count as unknown in the coin score. */
const COIN_SECTIONS: CoinSignals['unknown'][number]['section'][] = ['deployer', 'bundle', 'holders', 'lp', 'authorities'];

export interface NothingTested {
  /** the public sentence: Check.error and the check's last step */
  message: string;
  /** every lookup answered: "Not enough to check" (core isNotEnough), not an outage */
  final: boolean;
}

/** Every claim's final status as Stage F saves it: the judge's (or the stand-in's), "not seen" where it said nothing. */
export function claimStatuses(run: CheckRun): ClaimStatus[] {
  const { judged } = finalJudgement(run);
  return run.claims.map((_, i) => (judged.claims.find(x => x.index === i)?.status ?? 'not_seen') as ClaimStatus);
}

/**
 * The site answered: it loaded, or it failed to load on its side (an error, no response: a dead project site, scored
 * as not loading). A site that blocks automated browsers, our own browser failing on it, or no time left to open it
 * say nothing about the project.
 */
export function siteAnswered(run: CheckRun): boolean {
  if (run.site.loaded) return true;
  if (!run.site.hasSite || run.site.infraError) return false;
  return !run.degraded.some(d => d === 'browse:blocked' || d === 'browse:error' || d === 'open:skipped');
}

/** The coin was tested: at least one of its scored sections was read (all unknown: the score would be made up). */
export function coinRead(run: CheckRun): boolean {
  const c = run.coin;
  return !!c && COIN_SECTIONS.some(s => !c.signals.unknown.some(u => u.section === s));
}

/** Something about the project was tested: a site that answered, docs, a GitHub repo, a coin fact, or a claim settled either way. */
export function testedAnything(run: CheckRun, claims: readonly ClaimStatus[]): boolean {
  return siteAnswered(run) || !!run.docs.result || (run.git.facts?.repos.length ?? 0) > 0 || coinRead(run) || claims.some(c => c !== 'not_seen');
}

const isProfile = (run: CheckRun) => run.detected?.kind === 'xpost' && !run.detected.postId;

/** The target as the reason names it: "@stridefun", "orbitswap.xyz", "0x17c6…d1fc", "the post by @foo". */
function subjectOf(run: CheckRun): string {
  const d = run.detected;
  if (run.kind === 'coin') return (run.ticker ? `$${run.ticker}` : short(run.ca ?? (d && 'address' in d ? d.address : null))) || 'the contract';
  if (run.kind === 'site') return run.domain ?? 'the site';
  if (d?.kind === 'xpost' && d.postId) return run.handle ? `the post by @${run.handle}` : 'the post';
  return run.handle ? `@${run.handle}` : 'the X account';
}

/** The coin as the reason names it: "$ORB", else its short address. */
const coinName = (run: CheckRun) => (run.ticker ? `$${run.ticker}` : short(run.ca));

/** Why the coin's facts are all unknown when a source failed ("the Base RPC didn't answer"); null when every one answered. */
function coinOutage(run: CheckRun): string | null {
  const c = run.coin;
  if (!c || coinRead(run)) return null;
  const rpc = rpcOutage(run.chain!, c.raw.errors);
  if (rpc) return `${rpc === 'TronGrid' ? rpc : `the ${rpc}`} didn't answer`;
  if (c.raw.errors.some(e => /^coinFacts: (timeout|not gathered in time)$/.test(e))) return `${coinName(run)}'s on-chain data wasn't gathered in time`;
  if (c.raw.errors.some(e => e.startsWith('coinFacts:'))) return `reading ${coinName(run)}'s on-chain data failed`;
  return null;
}

/** The lookups that could have found something but didn't answer, as clauses ("GitHub didn't answer"); [] when all did. */
function outages(run: CheckRun, subject: string): string[] {
  const out: string[] = [];
  const resolve = run.degraded.find(d => d.startsWith('resolve:'));
  if (resolve) out.push(resolve === 'resolve:error' ? 'looking it up failed' : 'looking it up ran out of time');
  if (run.detected?.kind === 'xpost' && run.detected.postId && !run.post) out.push("the post couldn't be read on X");
  const u = run.unconfirmedCoin;
  if (u) {
    const of = short(u.address) === subject ? '' : ` for ${short(u.address)}`;
    out.push(`${u.why.replace(/ unavailable$/, " didn't answer")}${of}`);
  }
  const coin = coinOutage(run);
  if (coin) out.push(coin);
  if (!run.site.loaded && run.degraded.includes('browse:error')) out.push(`our test browser failed on ${run.domain ?? 'the site'}`);
  else if (!run.site.loaded && run.degraded.includes('open:skipped')) out.push(`there was no time left to open ${run.domain ?? 'the site'}`);
  if (run.git.unknown === 'unavailable') out.push("GitHub didn't answer");
  else if (!run.git.signal && !run.git.unknown) out.push('GitHub was not reached in time');
  return out;
}

/** "A", "A, and B", "A, B, and C": the clauses carry their own commas ("Sonic, which ApeCheck can't read yet"). */
const clauses = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`);

/** The name GitHub was searched for, as the reason shows it: the site's domain, "@handle", "$TICKER", or the token's name. */
function searchedFor(run: CheckRun, name: string): string {
  if (run.domain && run.domain.split('.')[0] === name) return run.domain;
  if (run.handle === name) return `@${name}`;
  if (run.ticker === name) return `$${name}`;
  return name;
}

/**
 * What was looked up, for this target, and found nothing to test; only lookups that ran are named:
 *  - "Not enough to check: ApeCheck doesn't read X profiles, and no GitHub repo was found for @stridefun. Tag me under
 *    a post with its link or contract." (an X profile: only the name search ran);
 *  - "Not enough to check: 0x17c…d1fc trades on Sonic, which ApeCheck can't read yet, and its token info lists no
 *    website." (run.otherChain); "0x17c…d1fc is not on Base, Ethereum, BNB Chain or Arbitrum" (run.missingCoin);
 *  - "foo.xyz blocks automated browsers", "the post by @foo links no project website, no coin was found in it",
 *    "none of the coin facts ApeCheck scores were found for $ORB on Base" (a deployer wallet and its history are
 *    shown, never scored); and the GitHub lookup that answered, when one ran.
 */
function notEnoughText(run: CheckRun, subject: string): string {
  const profile = isProfile(run);
  const said: string[] = [];
  // whether the last clause is about the target itself (a later clause may then call it "it")
  let aboutTarget = false;
  const say = (clause: string, ofTarget: boolean) => {
    said.push(clause);
    aboutTarget = ofTarget;
  };
  const coinTarget = run.kind === 'coin';
  if (profile) say("ApeCheck doesn't read X profiles", false);
  if (run.kind === 'post' && run.post) {
    // the post was read: what it didn't give (a contract it names that no chain has, or one on another chain: below)
    if (!run.site.hasSite) say(`${subject} links no project website`, true);
    if (!run.coinAnnounced && !run.hasCoin() && !run.missingCoin) say(`no coin was found in ${run.site.hasSite ? subject : 'it'}`, true);
  }
  // a site found but not read: only a bot wall is an answer (our browser failing on it is an outage)
  if (run.site.hasSite && !siteAnswered(run) && run.degraded.includes('browse:blocked')) say(`${run.domain ?? 'the site'} blocks automated browsers`, run.kind === 'site');
  const o = run.otherChain;
  if (o) {
    say(`${short(o.address)} trades on ${o.chain}, which ApeCheck can't read yet`, coinTarget);
    // a pasted contract: its token info is where its website would be (a post or a page is named above)
    if (coinTarget && !run.siteUrl) say('its token info lists no website', true);
  }
  const m = run.missingCoin;
  if (m) say(`${short(m.address)} is not on ${listOf(m.chains.map(c => CHAINS[c].name), 'or')}`, coinTarget);
  if (run.coin && !coinRead(run)) say(`none of the coin facts ApeCheck scores were found for ${coinName(run)} on ${CHAINS[run.chain!].name}`, coinTarget);
  const asked = run.git.asked;
  if (asked?.search) {
    // a post's or a profile's search is by its author's name, never "it"
    const name = searchedFor(run, asked.search);
    say(`no GitHub repo was found for ${aboutTarget && name === subject && run.kind !== 'post' ? 'it' : name}`, false);
  } else if (asked?.links) say(`the GitHub ${asked.links > 1 ? 'links' : 'link'} found led to no repo`, false);
  const reason = said.length ? clauses(said) : `nothing about ${subject} could be tested`;
  return `${NOT_ENOUGH_PREFIX}${reason}.${profile ? ` ${PROFILE_HINT}` : ''}`;
}

/** null when something about the project was tested (the check is scored); else how the check ends instead. */
export function nothingTested(run: CheckRun, claims: readonly ClaimStatus[]): NothingTested | null {
  if (testedAnything(run, claims)) return null;
  const subject = subjectOf(run);
  const down = outages(run, subject);
  if (down.length) return { message: clipSentence(`Nothing about ${subject} could be checked: ${listOf(down, 'and')}`, MAX_LEN), final: false };
  return { message: clipSentence(notEnoughText(run, subject), MAX_LEN), final: true };
}
