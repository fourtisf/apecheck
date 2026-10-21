/** Facts → signals: the deterministic rules (people, coin, docs, product). */
import { describe, expect, it } from 'vitest';
import { CONFIG, TUNING } from '@apecheck/core';
import { acctSignal, coinSignals, docsSignal, flowSignal, gitFacts, gitSignal, launchSignal, productSignals, type SiteFacts } from '../src/pipeline/signals';
import { classifySim, simChain } from '../src/pipeline/browse';
import { productSentence } from '../src/ai/phrases';
import { simSkipReason } from '../src/browser/agent';
import { detectBotWall } from '../src/browser/page';
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

  it('burst thresholds come from TUNING: a share strictly above gitBurstShare, at least gitBurstMinCommits commits', () => {
    expect([TUNING.gitBurstShare, TUNING.gitBurstMinCommits]).toEqual([0.5, 3]);
    const launch = iso(100 * DAY);
    const near = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(launch) - i * 3_600_000).toISOString());
    const far = (n: number) => Array.from({ length: n }, (_, i) => iso((5 + i * 10) * DAY));
    const facts = (dates: string[]) => gitFacts([repoFacts({ fullName: 'a/b', commits: dates.length, recentCommitDates: dates, firstCommit: dates[dates.length - 1], lastCommit: dates[0] })], launch, now);
    // exactly half inside the window: not a burst
    expect(facts([...near(2), ...far(2)]).burst).toBe(false);
    // more than half: a burst
    expect(facts([...near(3), ...far(2)]).burst).toBe(true);
    // all inside, but fewer than the minimum: not a burst
    expect(facts(near(TUNING.gitBurstMinCommits - 1)).burst).toBe(false);
    expect(facts(near(TUNING.gitBurstMinCommits)).burst).toBe(true);
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
  it('sections not checked are warn, an unknown deployer history is "mixed", each line says "not checked"', () => {
    const s = coinSignals(emptyCoinFacts('base', '0x1'));
    expect(s).toMatchObject({ record: 'mixed', historyKnown: false, deployer: 'warn', bundle: 'warn', holders: 'warn', lp: 'warn', authorities: 'warn' });
    expect(s.unknown.map(u => u.line)).toEqual([
      'Deployer history: not checked',
      'Bundle share: not checked',
      'Holder share: not checked',
      'LP status: not checked',
      'Mint and freeze authorities unknown',
    ]);
  });

  it('maps facts with CONFIG thresholds', () => {
    const f = emptyCoinFacts('sol', 'Mint111');
    // every section filled (no source fills a launch record, bundle or LP today: the mapping stays for when one does)
    f.deployer = { address: 'Dep', launched: 12, dead: 11, source: 'On-chain' };
    f.bundle = { pct: 31.5, wallets: 14, source: 'On-chain' };
    f.holders = { top10Pct: 18, devHoldPct: 9.5, count: 300, source: 'On-chain' };
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
    actions: [], entryFound: true, appReached: false, appVia: null, appUrl: null, appStepIdx: null, waitlist: null, comingSoon: null, errorScreen: null, jsError: null,
    deadLaunch: null, launch404: null, deadButtons: [], mainTried: false, mainOk: null, mainPartial: null, needsFunds: null, tx: null, doneReason: null, keyShots: [], ...p,
  });
  const docs = { link: null, result: null, timedOut: false, stepIdx: null };
  it('launch rules', () => {
    expect(launchSignal({ ...site, loaded: false, error: 'connection refused' }, null)).toMatchObject({ signal: 'fail', text: "The site didn't load (connection refused)" });
    expect(launchSignal(site, x({ entryFound: false }))).toMatchObject({ signal: 'warn', text: "The site says the product is live, but there is no 'Launch app' or similar button" });
    expect(launchSignal(site, x({ deadLaunch: { stepIdx: 2, text: "'Launch app' does nothing when clicked" } }))).toMatchObject({ signal: 'fail', stepIdx: 2 });
    expect(launchSignal(site, x({ waitlist: { stepIdx: 2, text: "'Launch app' opens a waitlist form", main: false } })).signal).toBe('warn');
    expect(launchSignal({ ...site, landingBlocked: 'coming_soon' }, null).signal).toBe('warn');
    expect(launchSignal({ ...site, hasSite: false }, null).signal).toBe('warn');
    // our browser was blocked (bot challenge): unchecked, never "doesn't load"
    expect(launchSignal({ ...site, loaded: false, error: 'the site blocks automated browsers', infraError: 'the site blocks automated browsers' }, null)).toMatchObject({
      signal: 'warn',
      text: 'The site could not be checked (the site blocks automated browsers)',
    });
  });

  it('a wallet connect alone does not outweigh an app entry that leads nowhere', () => {
    const wallet = { tool: 'click' as const, label: 'Connect wallet', role: 'entry' as const, outcome: 'wallet' as const, status: 'ok' as const, text: "'Connect wallet' asked the test wallet to connect", stepIdx: 5, url: null };
    const viaWallet = { appReached: true, appVia: 'wallet' as const, appStepIdx: 5, actions: [wallet] };
    // 'Launch app' shows 'Coming soon', a header 'Connect wallet' works
    expect(launchSignal(site, x({ ...viaWallet, comingSoon: { stepIdx: 3, text: "'Launch app' shows 'Coming soon'", main: false } }))).toEqual({
      signal: 'warn', text: "'Launch app' shows 'Coming soon' (only the wallet connect works)", stepIdx: 3,
    });
    // a dead 'Launch app' plus a working connect
    expect(launchSignal(site, x({ ...viaWallet, deadLaunch: { stepIdx: 3, text: "'Launch app' does nothing when clicked" } })).signal).toBe('fail');
    // the connect itself lands on a waitlist: not an app at all
    expect(launchSignal(site, x({ waitlist: { stepIdx: 3, text: "'Connect wallet' opens a waitlist form", main: false } })).signal).toBe('warn');
    // a landing page that is the app (connect works, nothing blocks) is still ok
    expect(launchSignal(site, x(viaWallet)).signal).toBe('ok');
    // an app screen that was really reached (route, amount field, transaction, signature) wins over a blocked entry
    expect(launchSignal(site, x({ ...viaWallet, appVia: 'page', comingSoon: { stepIdx: 3, text: "'Launch app' shows 'Coming soon'", main: false } })).signal).toBe('ok');
    expect(launchSignal(site, x({ ...viaWallet, comingSoon: { stepIdx: 3, text: 'x', main: false }, mainOk: { stepIdx: 7, text: 'signed' } })).signal).toBe('ok');
    // a waitlist behind the main action inside a real app is a flow problem, not a launch problem
    expect(launchSignal(site, x({ appReached: true, appVia: 'page', waitlist: { stepIdx: 6, text: 'Main flow stops at a waitlist form', main: true } })).signal).toBe('ok');

    // the summary follows the corrected launch signal
    const p = productSignals(site, x({ ...viaWallet, deadLaunch: { stepIdx: 3, text: "'Launch app' does nothing when clicked" } }), docs);
    expect(p.causes.deadLaunch).toBe(true);
    expect(p.flow.signal).toBe('fail');
    expect(productSentence(p.causes, p)).toBe("'Launch app' does nothing");
    const cs = productSignals(site, x({ ...viaWallet, comingSoon: { stepIdx: 3, text: "'Launch app' shows 'Coming soon'", main: false } }), docs);
    expect(productSentence(cs.causes, cs)).toBe("The app is still 'Coming soon'");
  });
  it('flow rules', () => {
    const launchOk = { signal: 'ok' as const, text: 'App opened', stepIdx: 2 };
    const tx = (simulated: 'ok' | 'fail' | 'skipped', needsFunds = false) => x({ appReached: true, tx: { reached: true, kind: 'evm', simulated, detail: 'execution reverted', needsFunds, chain: 'base', stepIdx: 4 } });
    expect(flowSignal(launchOk, tx('ok')).signal).toBe('ok');
    // reached but not simulated: not shown to work
    expect(flowSignal(launchOk, x({ appReached: true, tx: { reached: true, kind: 'evm', simulated: 'skipped', detail: 'fetch failed', needsFunds: false, chain: 'base', stepIdx: 4 } }))).toEqual({
      signal: 'warn', text: "Main flow reached a transaction; it couldn't be simulated (our Base RPC didn't answer)", stepIdx: 4,
    });
    // the main action only opened a dialog / changed the page: not a working flow
    expect(flowSignal(launchOk, x({ appReached: true, mainTried: true, mainPartial: { stepIdx: 5, text: "'Swap' opens a dialog; no transaction or signature followed", kind: 'modal' } }))).toEqual({
      signal: 'warn', text: "The main action opened a dialog; the flow wasn't completed", stepIdx: 5,
    });
    expect(flowSignal(launchOk, x({ appReached: true, mainTried: true, mainPartial: { stepIdx: 5, text: 'x', kind: 'changed' } })).signal).toBe('warn');
    // a signature request from the main action is a working flow
    expect(flowSignal(launchOk, x({ appReached: true, mainTried: true, mainOk: { stepIdx: 5, text: "'Swap' asked the test wallet to sign; the flow works up to that point" } })).signal).toBe('ok');
    // a dropped step (idx -1) is never cited
    expect(flowSignal(launchOk, x({ appReached: true, mainTried: true, mainPartial: { stepIdx: -1, text: 'x', kind: 'modal' } })).stepIdx).toBeNull();
    expect(flowSignal(launchOk, tx('fail', true)).signal).toBe('warn');
    expect(flowSignal(launchOk, tx('fail')).text).toBe('Main flow reached a transaction, but the simulation failed: execution reverted');
    expect(flowSignal(launchOk, x({ appReached: true, jsError: { stepIdx: 4, text: 'Main flow throws an error: TypeError' } })).signal).toBe('fail');
    expect(flowSignal(launchOk, x({ appReached: true })).text).toBe('Nothing to try in the app beyond the first screen');
    expect(flowSignal({ signal: 'warn', text: 'waitlist', stepIdx: 2 }, null).signal).toBe('warn');
  });
  it("'works end to end' only when a transaction simulated", () => {
    const appSite = { appReached: true, appVia: 'page' as const, appStepIdx: 2, mainTried: true };
    const sentence = (r: Partial<ExploreResult>) => {
      const p = productSignals(site, x({ ...appSite, ...r }), docs);
      return productSentence(p.causes, p);
    };
    expect(sentence({ tx: { reached: true, kind: 'evm', simulated: 'ok', detail: null, needsFunds: false, chain: 'base', stepIdx: 4 } })).toBe('The app works end to end');
    expect(sentence({ tx: { reached: true, kind: 'evm', simulated: 'skipped', detail: 'fetch failed', needsFunds: false, chain: 'base', stepIdx: 4 } })).toBe("The app reaches a transaction, but it couldn't be simulated");
    expect(sentence({ mainPartial: { stepIdx: 4, text: 'x', kind: 'modal' } })).toBe("The app loads but the main flow wasn't completed");
    expect(sentence({ mainOk: { stepIdx: 4, text: 'x' } })).toBe('The app works up to the wallet signature');
  });

  it('simulation chain: a chain the site switched to must be one we know', () => {
    // no chain id: the check's chain (or Ethereum)
    expect(simChain(null, '0x2105', 'base')).toBe('base');
    expect(simChain(null, '0x1', null)).toBe('eth');
    // still on the wallet's starting chain (Robinhood Chain has no numeric id here)
    expect(simChain('0x1', '0x1', 'rh')).toBe('rh');
    expect(simChain('0x2105', '0x1', null)).toBe('base');
    // Polygon / Optimism…: not simulated at all, never on Ethereum
    expect(simChain('0x89', '0x2105', 'base')).toBeNull();
    expect(simChain('0xa', '0x1', null)).toBeNull();
    expect(simSkipReason({ detail: 'unsupported chain 0x89', chain: null })).toBe("it targets a chain ApeCheck can't simulate (chain id 137)");
    expect(simSkipReason({ detail: 'not simulated in time', chain: 'base' })).toBe('not simulated in time');
  });

  it('bot walls: challenge markers, never a plain origin error', () => {
    expect(detectBotWall(403, { 'cf-mitigated': 'challenge', server: 'cloudflare' }, 'Just a moment...')).toBe('Cloudflare bot challenge');
    expect(detectBotWall(503, { server: 'cloudflare' }, 'Just a moment...')).toBe('bot challenge page');
    expect(detectBotWall(403, {}, 'Attention Required! | Cloudflare')).toBe('bot challenge page');
    expect(detectBotWall(403, { 'x-vercel-mitigated': 'challenge' }, '')).toBe('Vercel bot challenge');
    expect(detectBotWall(429, {}, 'Too Many Requests')).toBe('rate limited');
    expect(detectBotWall(403, { server: 'cloudflare' }, '403 Forbidden')).toBeNull();
    expect(detectBotWall(404, {}, 'Not Found')).toBeNull();
    expect(detectBotWall(503, { server: 'nginx' }, 'Service Unavailable')).toBeNull();
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
