/** Facts → signals: the deterministic rules (people, coin, docs, product). */
import { describe, expect, it } from 'vitest';
import { CONFIG, TUNING } from '@apecheck/core';
import { acctSignal, coinSignals, docsSignal, flowSignal, gitFacts, gitSignal, launchSignal, type SiteFacts } from '../src/pipeline/signals';
import { classifySim } from '../src/pipeline/browse';
import type { ExploreResult } from '../src/browser/agent';
import { emptyCoinFacts, repoFacts, xUser } from './fakes';

const DAY = 86_400_000;
const now = Date.parse('2026-10-19T12:00:00Z');
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

describe('git signal', () => {
  it('healthy history is ok', () => {
    const g = gitFacts([repoFacts({ fullName: 'orbit/core', commits: 412, lastCommit: iso(2 * DAY), firstCommit: iso(400 * DAY), recentCommitDates: Array.from({ length: 100 }, (_, i) => iso((2 + i * 3) * DAY)) })], null, now);
    expect(gitSignal(g, { claimsOpenSource: true, anchor: 'first', now })).toEqual({ signal: 'ok', text: '412 commits, last push 2 days ago' });
  });

  it('a burst at token launch is warn', () => {
    const launch = iso(10 * DAY);
    const dates = Array.from({ length: 9 }, (_, i) => new Date(Date.parse(launch) - i * 3_600_000).toISOString());
    const g = gitFacts([repoFacts({ fullName: 'orbit/app', commits: 9, firstCommit: dates[8], lastCommit: dates[0], recentCommitDates: dates })], launch, now);
    expect(g.burst).toBe(true);
    expect(gitSignal(g, { claimsOpenSource: true, anchor: 'launch', now })).toEqual({ signal: 'warn', text: `1 repo, 9 commits, all within ${CONFIG.gitBurstHours}h of launch` });
  });

  it('no repository: fail when the site claims open source, warn otherwise', () => {
    const g = gitFacts([], null, now);
    expect(gitSignal(g, { claimsOpenSource: true, anchor: 'first', now })).toEqual({ signal: 'fail', text: 'no repository found, site says "open source"' });
    expect(gitSignal(g, { claimsOpenSource: false, anchor: 'first', now })).toEqual({ signal: 'warn', text: 'no repository found' });
  });

  it('thin, stale and fork-only histories are warn', () => {
    const spread = (n: number, start: number) => Array.from({ length: n }, (_, i) => iso(start + i * 20 * DAY));
    const thin = gitFacts([repoFacts({ fullName: 'a/b', commits: TUNING.gitThinCommits - 1, lastCommit: iso(5 * DAY), firstCommit: iso(200 * DAY), recentCommitDates: spread(TUNING.gitThinCommits - 1, 5 * DAY) })], null, now);
    expect(gitSignal(thin, { claimsOpenSource: false, anchor: 'first', now })!.signal).toBe('warn');
    const stale = gitFacts([repoFacts({ fullName: 'a/b', commits: 300, lastCommit: iso((TUNING.gitStaleDays + 30) * DAY), firstCommit: iso(900 * DAY), recentCommitDates: spread(100, (TUNING.gitStaleDays + 30) * DAY) })], null, now);
    expect(gitSignal(stale, { claimsOpenSource: false, anchor: 'first', now })).toEqual({ signal: 'warn', text: '300 commits, last push 5 months ago' });
    const forks = gitFacts([repoFacts({ fullName: 'a/uniswap-fork', fork: true })], null, now);
    expect(gitSignal(forks, { claimsOpenSource: true, anchor: 'first', now })).toEqual({ signal: 'warn', text: 'only forks of other projects (1 repo)' });
  });

  it('unknown (GitHub unavailable) stays null for the judge', () => {
    expect(gitSignal(null, { claimsOpenSource: true, anchor: 'first' })).toBeNull();
  });
});

describe('acct signal', () => {
  it('uses CONFIG.acctAgeDays and TUNING.acctLowFollowers', () => {
    expect(acctSignal(xUser({ handle: 'orbit', createdAt: iso(830 * DAY), followers: 41_200 }), null, now)).toEqual({ signal: 'ok', text: '@orbit: 2y 3m old, 41.2k followers' });
    expect(acctSignal(xUser({ handle: 'orbit', createdAt: iso(830 * DAY), followers: 41_200 }), 0, now)!.text).toBe('@orbit: 2y 3m old, 41.2k followers, never renamed');
    expect(acctSignal(xUser({ handle: 'o', createdAt: iso((CONFIG.acctAgeDays.ok - 10) * DAY), followers: 9_000 }), null, now)!.signal).toBe('warn');
    expect(acctSignal(xUser({ handle: 'o', createdAt: iso(12 * DAY), followers: 300 }), null, now)).toEqual({ signal: 'fail', text: '@o: 12 days old, 300 followers' });
    expect(acctSignal(xUser({ handle: 'o', createdAt: iso(400 * DAY), followers: TUNING.acctLowFollowers - 1 }), null, now)!.signal).toBe('warn');
    expect(acctSignal(null, null, now)).toBeNull();
  });
});

describe('coin signals (core helpers only)', () => {
  it('unknown sections are warn, unknown deployer history is "mixed", each says which source was missing', () => {
    const s = coinSignals(emptyCoinFacts('base', '0x1'));
    expect(s).toMatchObject({ record: 'mixed', historyKnown: false, deployer: 'warn', bundle: 'warn', holders: 'warn', lp: 'warn', authorities: 'warn' });
    expect(s.unknown.map(u => u.line)).toEqual([
      'DevRadar unavailable, deployer history unknown',
      'BundleScan unavailable, bundle share unknown',
      'WhaleFlow unavailable, holder share unknown',
      'LP status unknown, liquidity lock not checked',
      'Mint and freeze authorities unknown',
    ]);
  });

  it('maps facts with CONFIG thresholds', () => {
    const f = emptyCoinFacts('sol', 'Mint111');
    f.deployer = { address: 'Dep', fundedFrom: null, launched: 12, dead: 11, firstSeen: null, source: 'DevRadar' };
    f.bundle = { pct: 31.5, wallets: 14, source: 'BundleScan' };
    f.holders = { top10Pct: 18, devHoldPct: 9.5, count: 300, source: 'WhaleFlow' };
    f.lp = { status: 'locked', lockedDays: 30, source: 'On-chain' };
    f.authorities = { mintRenounced: true, freezeActive: true, owner: null, text: 'Mint renounced, freeze active', source: 'On-chain' };
    const s = coinSignals(f);
    expect(s).toMatchObject({ record: 'serial', deployer: 'fail', bundle: 'fail', holders: 'fail', lp: 'warn', authorities: 'warn', lpStatus: 'locked:30', lpText: 'locked 30 days' });
    expect(s.unknown).toEqual([]);
  });
});

describe('docs signal', () => {
  const base = { link: 'https://docs.x.xyz', timedOut: false, stepIdx: 3 };
  const res = (p: Partial<import('../src/browser/docs').DocsResult>) => ({
    url: 'https://docs.x.xyz', reachable: true, status: 200, error: null, pages: 1, broken: 0, depth: 0, lastUpdated: null, technical: false, pdf: false, timedOut: false, text: '', links: [], shot: null, ...p,
  });
  it('ok with enough pages, warn when thin or broken, fail on 404', () => {
    expect(docsSignal({ ...base, result: res({ pages: 14, lastUpdated: new Date(Date.now() - 3 * DAY) }) }, true, true).e).toEqual({ signal: 'ok', text: 'Docs: 14 pages, last edited 3 days ago', stepIdx: 3 });
    expect(docsSignal({ ...base, result: res({ pages: 1 }) }, true, true).plain).toBe('a single page with no technical detail');
    expect(docsSignal({ ...base, result: res({ pages: 9, broken: 2 }) }, true, true).e.signal).toBe('warn');
    expect(docsSignal({ ...base, result: res({ reachable: false, status: 404, pages: 0, broken: 1 }) }, true, true).e).toMatchObject({ signal: 'fail', text: 'Docs: link returns 404' });
    expect(docsSignal({ link: null, result: null, timedOut: false, stepIdx: null }, true, true).e.text).toBe('Docs: no docs link on the site');
    expect(docsSignal({ ...base, result: null, timedOut: true }, true, true).plain).toBe('docs link timed out');
  });
});

describe('product signals', () => {
  const site: SiteFacts = { hasSite: true, loaded: true, error: null, claimsLive: true, landingBlocked: null, loadStepIdx: 1 };
  const x = (p: Partial<ExploreResult>): ExploreResult => ({
    actions: [], entryFound: true, appReached: false, appUrl: null, appStepIdx: null, waitlist: null, comingSoon: null, errorScreen: null, jsError: null,
    deadLaunch: null, launch404: null, deadButtons: [], mainTried: false, mainOk: null, needsFunds: null, tx: null, doneReason: null, keyShots: [], ...p,
  });
  it('launch rules', () => {
    expect(launchSignal({ ...site, loaded: false, error: 'connection refused' }, null)).toMatchObject({ signal: 'fail', text: "The site didn't load (connection refused)" });
    expect(launchSignal(site, x({ entryFound: false }))).toMatchObject({ signal: 'warn', text: "The site says the product is live, but there is no 'Launch app' or similar button" });
    expect(launchSignal(site, x({ deadLaunch: { stepIdx: 2, text: "'Launch app' does nothing when clicked" } }))).toMatchObject({ signal: 'fail', stepIdx: 2 });
    expect(launchSignal(site, x({ waitlist: { stepIdx: 2, text: "'Launch app' opens a waitlist form" } })).signal).toBe('warn');
    expect(launchSignal({ ...site, landingBlocked: 'coming_soon' }, null).signal).toBe('warn');
    expect(launchSignal({ ...site, hasSite: false }, null).signal).toBe('warn');
  });
  it('flow rules', () => {
    const launchOk = { signal: 'ok' as const, text: 'App opened', stepIdx: 2 };
    const tx = (simulated: 'ok' | 'fail' | 'skipped', needsFunds = false) => x({ appReached: true, tx: { reached: true, kind: 'evm', simulated, detail: 'execution reverted', needsFunds, chain: 'base', stepIdx: 4 } });
    expect(flowSignal(launchOk, tx('ok')).signal).toBe('ok');
    expect(flowSignal(launchOk, tx('skipped')).signal).toBe('ok');
    expect(flowSignal(launchOk, tx('fail', true)).signal).toBe('warn');
    expect(flowSignal(launchOk, tx('fail')).text).toBe('Main flow reached a transaction, but the simulation failed: execution reverted');
    expect(flowSignal(launchOk, x({ appReached: true, jsError: { stepIdx: 4, text: 'Main flow throws an error: TypeError' } })).signal).toBe('fail');
    expect(flowSignal(launchOk, x({ appReached: true })).text).toBe('Nothing to try in the app beyond the first screen');
    expect(flowSignal({ signal: 'warn', text: 'waitlist', stepIdx: 2 }, null).signal).toBe('warn');
  });
  it('simulation outcomes: no funds is the wallet, not the project', () => {
    expect(classifySim({ ok: false, error: 'insufficient funds for gas * price + value' }, 'base')).toMatchObject({ status: 'fail', needsFunds: true });
    expect(classifySim({ ok: false, error: 'Attempt to debit an account but found no record of a prior credit.' }, 'sol')).toMatchObject({ needsFunds: true });
    expect(classifySim({ ok: false, error: 'no RPC configured for Base' }, 'base').status).toBe('skipped');
    expect(classifySim({ ok: false, error: 'simulation failed: fetch failed' }, 'base')).toMatchObject({ status: 'skipped', detail: 'fetch failed' });
    expect(classifySim({ ok: false, error: 'simulation unavailable: HTTP 429' }, 'sol').status).toBe('skipped');
    expect(classifySim({ ok: false, error: 'execution reverted: TRANSFER_FAILED' }, 'base')).toMatchObject({ status: 'fail', needsFunds: false });
    expect(classifySim({ ok: true }, 'eth').status).toBe('ok');
  });
});
