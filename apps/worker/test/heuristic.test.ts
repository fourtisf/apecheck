/** The heuristic stand-in: exploration choices, claim cues, judge mapping and the prototype's phrasing. */
import { describe, expect, it } from 'vitest';
import { heuristicAnswer, heuristicClaims, heuristicExploreStep, heuristicJudge } from '../src/ai/heuristic';
import { resolveElement } from '../src/browser/agent';
import type { DomElement, ExploreObservation, JudgeInput, ProductCauses } from '../src/ai/types';

const el = (id: number, text: string, p: Partial<DomElement> = {}): DomElement => ({ id, kind: 'button', text, href: null, disabled: false, inViewport: true, inModal: false, ...p });
const flags = { appReached: false, walletRequested: false, walletConnected: false, txCaptured: false, waitlist: false, comingSoon: false, errorScreen: false };
const obs = (elements: DomElement[], f: Partial<typeof flags> = {}, modalText: string | null = null): ExploreObservation => ({
  step: 0, maxSteps: 6, screenshot: null, lastResult: null, history: [], flags: { ...flags, ...f },
  summary: { url: 'https://orbit.xyz/', title: 'Orbit', headings: [], elements, inputs: [], modalText, textSample: '' },
});

describe('heuristic exploration', () => {
  it('goes for the app entry first, never docs or socials', () => {
    const state = { siteUrl: 'https://orbit.xyz/', memory: {} };
    const els = [el(1, 'Docs', { kind: 'link', href: 'https://orbit.xyz/docs' }), el(2, 'Twitter', { kind: 'link', href: 'https://x.com/orbit' }), el(3, 'Get started'), el(4, 'Launch app', { kind: 'link', href: 'https://app.orbit.xyz' })];
    expect(heuristicExploreStep(state, obs(els))).toEqual({ tool: 'click', text: 'Launch app' });
    // the same element is not clicked twice
    expect(heuristicExploreStep(state, obs(els))).toEqual({ tool: 'click', text: 'Get started' });
  });
  it('then connects the wallet, picks the test wallet in a picker, then tries the main action', () => {
    const state = { siteUrl: 'https://orbit.xyz/', memory: {} };
    expect(heuristicExploreStep(state, obs([el(1, 'Swap'), el(2, 'Connect Wallet')], { appReached: true }))).toEqual({ tool: 'click', text: 'Connect Wallet' });
    expect(heuristicExploreStep(state, obs([el(3, 'WalletConnect', { inModal: true }), el(4, 'MetaMask', { inModal: true })], { appReached: true }, 'Connect a wallet'))).toEqual({ tool: 'click', text: 'MetaMask' });
    expect(heuristicExploreStep(state, obs([el(1, 'Swap'), el(5, 'Settings')], { appReached: true, walletRequested: true, walletConnected: true }))).toEqual({ tool: 'click', text: 'Swap' });
  });
  it('stops at a waitlist, a captured transaction or when nothing is left', () => {
    const s = () => ({ siteUrl: 'https://orbit.xyz/', memory: {} });
    expect(heuristicExploreStep(s(), obs([el(1, 'Launch app')], { waitlist: true })).tool).toBe('done');
    expect(heuristicExploreStep(s(), obs([el(1, 'Swap')], { txCaptured: true })).tool).toBe('done');
    const st = s();
    expect(heuristicExploreStep(st, obs([el(1, 'About')]))).toEqual({ tool: 'scroll', direction: 'down' });
    expect(heuristicExploreStep(st, obs([el(1, 'About')])).tool).toBe('done');
  });
  it('resolveElement accepts numbers, exact and partial text', () => {
    const s = obs([el(1, 'Launch app'), el(2, 'Launch app now'), el(7, 'Connect wallet')]).summary;
    expect(resolveElement(s, '#7')?.id).toBe(7);
    expect(resolveElement(s, '[2]')?.id).toBe(2);
    expect(resolveElement(s, 'launch APP')?.id).toBe(1);
    expect(resolveElement(s, 'Connect')?.id).toBe(7);
    expect(resolveElement(s, 'nothing like it')).toBeNull();
  });
});

describe('heuristic claims', () => {
  it('pulls cue sentences from each source with the right kind', () => {
    const claims = heuristicClaims({
      name: 'Orbit', siteUrl: null,
      hero: 'Swap anything, instantly\nLive on Base mainnet.\nOpen-source code, every contract on GitHub.\nFull documentation for builders.\nThe future of finance.',
      footer: 'Fair launch, no presale. © 2026 Orbit.',
      docs: 'Orbit documentation\nAudited by CertiK in September.',
      post: 'Our AI agent trades on-chain for you 24/7.',
      bio: 'Backed by Paradigm. Doxxed team of ex-Google engineers.',
    });
    const byKind = Object.fromEntries(claims.map(c => [c.kind, c]));
    expect(byKind.mainnet).toEqual({ text: 'Live on Base mainnet', source: 'site_hero', kind: 'mainnet' });
    expect(byKind.open_source.source).toBe('site_hero');
    expect(byKind.docs.text).toBe('Full documentation for builders');
    expect(byKind.fair_launch.text).toBe('Fair launch, no presale');
    expect(byKind.ai_agent.source).toBe('post');
    expect(byKind.audit.source).toBe('docs');
    expect(byKind.team.source).toBe('x_bio');
    expect(byKind.partnership.text).toBe('Backed by Paradigm');
    expect(claims.some(c => /future of finance|Orbit documentation/.test(c.text))).toBe(false);
    expect(claims.length).toBeLessThanOrEqual(8);
  });
});

const causes = (p: Partial<ProductCauses> = {}): ProductCauses => ({
  notLoaded: false, noSite: false, noEntry: false, waitlist: false, comingSoon: false, deadLaunch: false, launch404: false, appReached: true,
  walletConnected: true, txReached: false, txSimulated: null, needsFunds: false, errorScreen: null, jsError: null, nothingToTry: false, ...p,
});
const sig = (signal: 'ok' | 'warn' | 'fail', text: string, stepIdx: number | null = null) => ({ signal, text, stepIdx });
function input(p: Partial<JudgeInput> = {}): JudgeInput {
  return {
    name: 'Orbit', kind: 'site',
    claims: [
      { text: 'Live on Base mainnet', source: 'site_hero', kind: 'mainnet' },
      { text: 'Open-source code', source: 'site_hero', kind: 'open_source' },
      { text: 'Full documentation', source: 'site_hero', kind: 'docs' },
      { text: 'Experienced public team', source: 'x_bio', kind: 'team' },
      { text: 'Audited', source: 'footer', kind: 'audit' },
      { text: 'AI agent trades for you', source: 'post', kind: 'ai_agent' },
    ],
    product: { launch: sig('ok', 'App opened and wallet connect works', 2), flow: sig('ok', 'Ran the main flow', 4), docs: sig('ok', 'Docs: 9 pages', 5) },
    causes: causes({ txReached: true, txSimulated: 'ok' }),
    people: { acct: sig('ok', '@orbit: 2y old', 7), git: sig('fail', 'GitHub: no repository found, site says "open source"', 6) },
    git: { found: false, burst: false, totalCommits: 0, stale: false, thin: false, onlyForks: false },
    coin: null, auditLink: null, steps: [],
    evidence: { site: { url: 'https://orbit.xyz', finalUrl: null, title: null, loadMs: null, loaded: true, httpStatus: 200, consoleErrors: [], waitlist: false, comingSoon: false, deadButtons: [], appUrl: null, wallet: { requested: true, connected: true, methods: [], tx: { reached: true, simulated: 'ok', chain: 'base', detail: null } } } },
    screenshots: [],
    ...p,
  };
}

describe('heuristic judge', () => {
  it('maps claims to statuses from the signals, citing the step', () => {
    const j = heuristicJudge(input());
    // an AI agent is never "seen" from a working swap
    expect(j.claims.map(c => c.status)).toEqual(['seen_working', 'contradicted', 'seen_working', 'checks_out', 'not_seen', 'not_seen']);
    expect(j.claims[5].evidence).toBe('Nothing the agent saw shows an AI agent at work');
    expect(j.claims[1]).toMatchObject({ evidence: 'GitHub: no repository found, site says "open source"', stepIdx: 6 });
    expect(j.summary).toBe('The app works end to end; no code backs the open-source claim.');
    expect(j.acct).toBe('ok');
    expect(j.coinSummary).toBeNull();
    const withAudit = heuristicJudge(input({ auditLink: { url: 'https://orbit.xyz/audit.pdf', stepIdx: 1 } }));
    expect(withAudit.claims[4].status).toBe('checks_out');
  });

  it('mainnet is seen only from a transaction that simulated fine on the chain the claim names', () => {
    const flowOk = { launch: sig('ok', 'App opened', 2), flow: sig('ok', 'Ran the main flow with a test wallet', 4), docs: sig('ok', 'x') };
    const evidence = (chain: string) => ({ site: { ...input().evidence.site!, wallet: { requested: true, connected: true, methods: [], tx: { reached: true, simulated: 'ok' as const, chain, detail: null } } } });
    const onEth = heuristicJudge(input({ product: flowOk, evidence: evidence('eth') }));
    expect(onEth.claims[0]).toMatchObject({ status: 'not_seen', evidence: 'The transaction the agent reached runs on Ethereum, not Base' });
    // a flow that only reached a signature, or a transaction that wasn't simulated, doesn't show the chain
    const signed = heuristicJudge(input({ product: flowOk, causes: causes({ mainSigned: true }), evidence: {} }));
    expect(signed.claims[0].status).toBe('not_seen');
    expect(signed.summary).toMatch(/^The app works up to the wallet signature; /);
    const notSimulated = heuristicJudge(input({ product: { ...flowOk, flow: sig('warn', "Main flow reached a transaction; it couldn't be simulated (our Base RPC didn't answer)", 4) }, causes: causes({ txReached: true, txSimulated: 'skipped' }) }));
    expect(notSimulated.claims[0].status).toBe('not_seen');
    expect(notSimulated.summary).toMatch(/^The app reaches a transaction, but it couldn't be simulated; /);
    // the main button only opened a dialog: the flow is not "end to end", and no chain/AI claim is seen
    const dialog = heuristicJudge(input({
      product: { ...flowOk, flow: sig('warn', "The main action opened a dialog; the flow wasn't completed", 4) },
      causes: causes({ mainPartial: true }),
      evidence: {},
    }));
    expect(dialog.summary).toMatch(/^The app loads but the main flow wasn't completed; /);
    expect(dialog.claims.filter(c => c.status === 'seen_working').map(c => c.index)).toEqual([2]);
    // a product that doesn't open contradicts an "AI agent" product
    const dead = heuristicJudge(input({ product: { launch: sig('fail', "'Launch app' does nothing when clicked", 2), flow: sig('fail', 'x'), docs: sig('ok', 'x') }, causes: causes({ deadLaunch: true, appReached: false }) }));
    expect(dead.claims[5].status).toBe('contradicted');
  });

  it('never cites a dropped step (idx -1)', () => {
    const j = heuristicJudge(input({ product: { launch: sig('ok', 'App opened', -1), flow: sig('ok', 'x', -1), docs: sig('ok', 'Docs: 9 pages', -1) } }));
    expect(j.claims.every(c => c.stepIdx == null || c.stepIdx >= 0)).toBe(true);
    expect(j.claims[2].stepIdx).toBeNull();
  });

  it("writes the prototype's summaries", () => {
    const waitlist = heuristicJudge(input({ causes: causes({ waitlist: true, appReached: false }), product: { launch: sig('warn', "'Launch app' opens a waitlist form"), flow: sig('warn', 'x'), docs: sig('warn', 'x') }, people: { acct: null, git: sig('warn', 'burst') }, git: { found: true, burst: true, totalCommits: 9, stale: false, thin: true, onlyForks: false } }));
    expect(waitlist.summary).toBe("The 'live' app is a waitlist; the GitHub was pushed in one burst at launch.");
    expect(waitlist.claims[0].status).toBe('not_seen');
    const dead = heuristicJudge(input({ causes: causes({ deadLaunch: true, appReached: false }), product: { launch: sig('fail', "'Launch app' does nothing when clicked", 2), flow: sig('fail', 'x'), docs: sig('ok', 'x') }, people: { acct: null, git: sig('ok', 'GitHub: 412 commits') } }));
    expect(dead.summary).toBe("'Launch app' does nothing; code is public and active.");
    expect(dead.claims[0].status).toBe('contradicted');
    const coming = heuristicJudge(input({ causes: causes({ comingSoon: true }), product: { launch: sig('ok', 'App opened'), flow: sig('warn', "Main flow stops at a 'Coming soon' screen", 6), docs: sig('ok', 'x') } }));
    expect(coming.summary).toMatch(/^The app loads but the main flow stops at 'Coming soon'; /);
    // an app that opens doesn't prove the chain: "Live on Base mainnet" is only seen when the main flow worked
    expect(coming.claims[0]).toMatchObject({ status: 'not_seen', evidence: "Main flow stops at a 'Coming soon' screen", stepIdx: 6 });
  });

  it('says the code could not be checked when GitHub was unavailable, never that none was found', () => {
    const base = { causes: causes({ comingSoon: true }), product: { launch: sig('ok', 'App opened'), flow: sig('warn', "Main flow stops at a 'Coming soon' screen"), docs: sig('ok', 'x') } };
    const unchecked = heuristicJudge(input({ ...base, people: { acct: null, git: null }, git: { found: false, burst: false, totalCommits: 0, stale: false, thin: false, onlyForks: false, unchecked: true } }));
    expect(unchecked.summary).toBe("The app loads but the main flow stops at 'Coming soon'; the code could not be checked.");
    expect(unchecked.git).toBe('warn');
    // the team claim cites why the account is unknown, never "no X account" when there is one
    expect(unchecked.claims[3]).toMatchObject({ status: 'not_seen', evidence: 'No X account to check' });
    const xDown = heuristicJudge(input({ ...base, people: { acct: null, git: null }, evidence: { acct: '@orbit: account could not be read' } }));
    expect(xDown.claims[3]).toMatchObject({ status: 'not_seen', evidence: '@orbit: account could not be read' });
    const searched = heuristicJudge(input({ ...base, people: { acct: null, git: sig('warn', 'GitHub: no repository found') } }));
    expect(searched.summary).toBe("The app loads but the main flow stops at 'Coming soon'; no public code was found.");
  });

  it('adds the coin sentence only when the coin scores under 60; fair launch checks out against the bundle', () => {
    const coin = (score: number, bundle: 'ok' | 'fail') => ({
      record: 'builder' as const, historyKnown: true, launched: 1, dead: 0, bundlePct: bundle === 'ok' ? 2.1 : 31.2, bundleWallets: 9,
      top10Pct: 20, devHoldPct: 1, lpText: 'burned', authoritiesText: 'Renounced', score,
      signals: { deployer: 'ok' as const, bundle, holders: 'ok' as const, lp: 'ok' as const, authorities: 'ok' as const },
      evidence: { bundle: sig(bundle, 'Launch: 2.1% of supply bought by 9 bundled wallets', 9) },
    });
    const claims = [{ text: 'Fair launch, no team bundle', source: 'site_hero' as const, kind: 'fair_launch' as const }];
    const good = heuristicJudge(input({ claims, coin: coin(90, 'ok') }));
    expect(good.claims[0]).toMatchObject({ status: 'checks_out', stepIdx: 9 });
    expect(good.summary).not.toMatch(/bundled/);
    expect(good.coinSummary).toBe('Supply and liquidity look clean.');
    const bad = heuristicJudge(input({ claims, coin: coin(40, 'fail') }));
    expect(bad.claims[0].status).toBe('contradicted');
    expect(bad.summary).toMatch(/ 31\.2% of supply was bundled at launch\.$/);
  });
});

describe('heuristic answers', () => {
  it('answers from the stored check only', () => {
    const d = { name: '$X', kind: 'site' as const, narScore: 40, narBand: 'partly', coinScore: null, coinBand: null, summary: "The 'live' app is a waitlist; code is public and active.", coinSummary: null, signals: { launch: 'warn' as const }, evidence: { launch: "'Launch app' opens a waitlist form", git: '412 commits, last push 2 days ago' }, claims: [], coin: null };
    expect(heuristicAnswer('who funded the deployer?', d)).toBe('There is no coin linked to this one yet, so there is no deployer to trace.');
    expect(heuristicAnswer('is the github legit?', d)).toBe('GitHub: 412 commits, last push 2 days ago.');
    expect(heuristicAnswer('can I actually use the app today?', d)).toBe("'Launch app' opens a waitlist form.");
  });
});
