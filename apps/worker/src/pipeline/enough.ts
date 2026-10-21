/**
 * "Not enough to check". A check that could test nothing about the project ends FAILED with a plain reason instead of
 * a score: with nothing tested every signal is unknown, and unknowns add up to the neutral middle, so an X profile
 * with no links and a contract on a chain ApeCheck doesn't support would both read "PARTLY REAL (50/100)", a verdict
 * nothing supports.
 *
 * Nothing was tested when, from the run's own evidence, all of these hold:
 *  - no site loaded: none was found, it didn't load, or it blocks automated browsers (run.site.loaded);
 *  - no docs were read (run.docs.result);
 *  - no GitHub repo was found: none linked, and a search by the project's name found none, forks included
 *    (run.git.facts.repos);
 *  - no coin facts were read, i.e. no contract on a supported chain (run.coin: a coin on a supported chain is always
 *    assessed, an unread section counting as unknown);
 *  - no claim was confirmed or contradicted: every claim, if any, ends "not seen".
 * Anything tested is scored as before: a site that loaded but has no repo, a repo without a site, a coin, a claim
 * contradicted because the site that says it is live didn't load.
 *
 * Two kinds of nothing, told apart by whether every lookup that could have found something answered:
 *  - all answered: "Not enough to check: <what was looked for, for this target>." (core NOT_ENOUGH_PREFIX). An answer,
 *    not an outage: the bot posts the reason, the report says what was looked for, nobody is told to try again;
 *  - one didn't (Stage A or D cut short, GitHub down, the post unreadable, an address the RPCs or DexScreener couldn't
 *    vet, our browser failing on the site): "Nothing about <target> could be checked: <which>". The nothing is ours,
 *    so it is a failed run like any other (the bot and the report say to try again).
 */
import { CHAINS, NOT_ENOUGH_PREFIX, clipSentence, short, type ClaimStatus } from '@apecheck/core';
import type { CheckRun } from './context';
import { finalJudgement } from './judge';
import { listOf } from './resolve';

/** Check.error is shown up to 200 characters (apps/api mappers). */
const MAX_LEN = 200;

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

/** Something about the project was tested: a loaded site, docs, a GitHub repo, coin facts, or a claim settled either way. */
export function testedAnything(run: CheckRun, claims: readonly ClaimStatus[]): boolean {
  return run.site.loaded || !!run.docs.result || (run.git.facts?.repos.length ?? 0) > 0 || !!run.coin || claims.some(c => c !== 'not_seen');
}

/** The target as the reason names it: "@stridefun", "orbitswap.xyz", "0x17c6…d1fc", "the post by @foo". */
function subjectOf(run: CheckRun): string {
  const d = run.detected;
  if (run.kind === 'coin') return (run.ticker ? `$${run.ticker}` : short(run.ca ?? (d && 'address' in d ? d.address : null))) || 'the contract';
  if (run.kind === 'site') return run.domain ?? 'the site';
  if (d?.kind === 'xpost' && d.postId) return run.handle ? `the post by @${run.handle}` : 'the post';
  return run.handle ? `@${run.handle}` : 'the X account';
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
  if (run.degraded.includes('browse:error') && !run.site.loaded) out.push(`our test browser failed on ${run.domain ?? 'the site'}`);
  if (run.git.unknown === 'unavailable') out.push("GitHub didn't answer");
  else if (!run.git.signal && !run.git.unknown) out.push('GitHub was not reached in time');
  return out;
}

/**
 * "Not enough to check: no website, GitHub repo or contract on a supported chain was found for @stridefun." — what was
 * looked for, for this target: the site that didn't load (or blocks our browser), the contract no supported chain has
 * (with the chains asked), and the rest that was found nowhere.
 */
function notEnoughText(run: CheckRun, subject: string): string {
  const said: string[] = [];
  if (run.site.hasSite) {
    const site = run.domain ?? 'the site';
    said.push(run.degraded.includes('browse:blocked') ? `${site} blocks automated browsers` : `${site} didn't load`);
  }
  const m = run.missingCoin;
  if (m) said.push(`${short(m.address)} is not on ${listOf(m.chains.map(c => CHAINS[c].name), 'or')}`);
  const none = [run.site.hasSite ? null : 'website', 'GitHub repo', m ? null : 'contract on a supported chain'].filter((s): s is string => !!s);
  // "it" is the site or contract just named; a post is named again ("it" would read as the site it links)
  const found = `no ${listOf(none, 'or')} was found for ${said.length && run.kind !== 'post' ? 'it' : subject}`;
  return `${NOT_ENOUGH_PREFIX}${said.length ? `${said.join(', ')}, and ${found}` : found}.`;
}

/** null when something about the project was tested (the check is scored); else how the check ends instead. */
export function nothingTested(run: CheckRun, claims: readonly ClaimStatus[]): NothingTested | null {
  if (testedAnything(run, claims)) return null;
  const subject = subjectOf(run);
  const down = outages(run, subject);
  if (down.length) return { message: clipSentence(`Nothing about ${subject} could be checked: ${listOf(down, 'and')}`, MAX_LEN), final: false };
  return { message: clipSentence(notEnoughText(run, subject), MAX_LEN), final: true };
}
