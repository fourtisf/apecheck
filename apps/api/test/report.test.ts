import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hueOf, progressKey, type CheckEvidence, type CheckReportDTO } from '@apecheck/core';
import {
  Client, APP_URL, EvmWallet, makeHarness, parseSse, resetState, seedCheck, seedCoinFacts, seedTarget, signedIn, type Harness,
} from './helpers';
import { coinVerdictOf, narrativeOf, renamedText, shotUrl, titleOf } from '../src/mappers';

const proW = new EvmWallet();
const maxW = new EvmWallet();

let h: Harness;
beforeAll(async () => {
  h = await makeHarness({ TIER_OVERRIDES: `${proW.address}:pro,${maxW.address}:max` });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetState(h);
});

const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const DEP = 'DevWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxxxxxx';
const PRIOR_MINT = 'Pr1orM1ntxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

async function seedFullCoinCheck() {
  const finishedAt = new Date(Date.now() - 6 * 3600_000);
  const createdAt = new Date(finishedAt.getTime() - 160_000);
  const startedAt = new Date(finishedAt.getTime() - 150_000);
  const target = await seedTarget(h.prisma, {
    kind: 'COIN',
    chain: 'SOL',
    ca: MINT,
    ticker: 'ORBIT',
    name: '$ORBIT',
    handle: 'orbit_xyz',
    domain: 'orbitswap.xyz',
    key: `ca:sol:${MINT}`,
    checkCount: 4,
    lastPrice: '0.0015',
    lastMc: '1500000',
    lastVol5m: '12000',
    lastCh24: -3.5,
    priceUpdatedAt: new Date(finishedAt.getTime() + 3 * 3600_000 + 60_000),
  });
  // another coin from the same wallet that ApeCheck has checked: the deployer history
  const prior = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca: PRIOR_MINT, ticker: 'PRIOR', name: '$PRIOR', key: `ca:sol:${PRIOR_MINT}` });
  const priorCheck = await seedCheck(h.prisma, {
    targetId: prior.id, shortId: 'prior01', status: 'DONE', isLatest: true, narScore: 70, coinScore: 62, totalScore: 66, narBand: 'likely', coinBand: 'ok',
    finishedAt: new Date(finishedAt.getTime() - 86400_000),
  });
  await seedCoinFacts(h.prisma, priorCheck.id, { deployerAddress: DEP });
  const user = await h.prisma.user.create({ data: { xHandle: 'trench_ken' } });
  const walletUser = await h.prisma.user.create({ data: { solAddress: 'So1anaWa11etxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } });
  const evidence: CheckEvidence = {
    launch: 'App opened and wallet connect works',
    flow: "Main flow stops at a 'Coming soon' screen",
    docs: '12 pages, last edited 3 days ago',
    git: '1 repo, 14 commits, all within 48h of launch',
    acct: '@orbit_xyz: 7 months old, renamed once',
    people: {
      handle: 'orbit_xyz',
      createdAt: new Date(Date.now() - 400 * 86400_000).toISOString(),
      followers: 12400,
      verified: false,
      renamed: 1,
      quality: 'About a third look bought',
      team: 'Anonymous, but the dev has a public build history',
      teamSignal: 'warn',
    },
    links: { site: 'https://orbitswap.xyz', x: 'https://x.com/orbit_xyz', github: ['https://github.com/orbit/app'], docs: 'https://docs.orbitswap.xyz' },
    market: { ch24: 9.9, vol5m: 1 },
    stepsExpected: 14,
  };
  const check = await seedCheck(h.prisma, {
    targetId: target.id,
    shortId: 'full001',
    targetRaw: MINT,
    status: 'DONE',
    via: 'BOT',
    requesterHandle: 'degen_rina',
    isLatest: true,
    sigLaunch: 'OK',
    sigFlow: 'WARN',
    sigDocs: 'OK',
    sigAcct: 'WARN',
    sigGit: 'WARN',
    evidence: evidence as object,
    narScore: 66,
    coinScore: 55,
    totalScore: 61,
    narBand: 'likely',
    coinBand: 'sketchy',
    areas: { Product: 75, Claims: 62, People: 50 },
    summary: "The app loads but the main flow stops at 'Coming soon'.",
    coinSummary: 'Holders are somewhat concentrated.',
    durationMs: 150_000,
    priceAtCheck: '0.001',
    mcAtCheck: '1000000',
    asksCount: 2,
    createdAt,
    startedAt,
    finishedAt,
  });
  await h.prisma.checkStep.createMany({
    data: [
      { checkId: check.id, idx: 0, tMs: 0, status: 'INFO', text: `Contract on Solana: 7xKXt…gAsU`, source: null },
      { checkId: check.id, idx: 1, tMs: 3200, status: 'OK', text: 'Website from token metadata: orbitswap.xyz', source: 'DexScreener' },
      { checkId: check.id, idx: 2, tMs: 9100, status: 'INFO', text: 'Opening orbitswap.xyz in a clean browser', url: 'https://orbitswap.xyz', caption: 'Loading page', screenshot: `${check.id}/2.jpg` },
    ],
  });
  // written in reverse: the report orders claims by Claim.idx, not by insertion
  await h.prisma.claim.createMany({
    data: [
      { checkId: check.id, idx: 3, text: 'Open-source code', source: 'footer', kind: 'open_source', status: 'CONTRADICTED', evidence: 'No repo', stepIdx: null },
      { checkId: check.id, idx: 2, text: 'AI agent trades for you', source: 'docs', kind: 'ai_agent', status: 'NOT_SEEN', evidence: 'Coming soon', stepIdx: 1 },
      { checkId: check.id, idx: 1, text: 'Fair launch, no team bundle', source: 'x_bio', kind: 'fair_launch', status: 'CHECKS_OUT', evidence: '3% bundled', stepIdx: null },
      { checkId: check.id, idx: 0, text: 'Live on Solana mainnet', source: 'site_hero', kind: 'mainnet', status: 'SEEN_WORKING', evidence: 'App opened (step 2)', stepIdx: 2 },
    ],
  });
  await h.prisma.coinFacts.create({
    data: {
      checkId: check.id,
      deployerAddress: DEP,
      sigDeployer: 'WARN',
      sigBundle: 'OK',
      sigHolders: 'WARN',
      sigLp: 'WARN',
      sigAuthorities: 'OK',
      bundlePct: 3.2,
      bundleWallets: 5,
      top10Pct: 31,
      devHoldPct: 4.1,
      lpStatus: 'locked:30',
      authorities: 'Renounced',
      holders: 2140,
      liquidityUsd: '84000.5',
      pairCreatedAt: new Date('2026-10-10T12:00:00Z'),
    },
  });
  // points before the check are ignored; 0 at the check, then since-% of each later point
  await h.prisma.pricePoint.createMany({
    data: [
      { targetId: target.id, ts: new Date(finishedAt.getTime() - 60_000), price: '0.0009' },
      { targetId: target.id, ts: new Date(finishedAt.getTime() + 3600_000), price: '0.0011' },
      { targetId: target.id, ts: new Date(finishedAt.getTime() + 2 * 3600_000), price: '0.0008' },
      { targetId: target.id, ts: new Date(finishedAt.getTime() + 3 * 3600_000), price: '0.0012' },
    ],
  });
  const ask = await h.prisma.ask.create({ data: { checkId: check.id, question: 'who funded the deployer?', answer: 'Binance hot wallet.', askerHandle: 'whalewatch', via: 'BOT', createdAt: new Date(Date.now() - 600_000) } });
  const ask2 = await h.prisma.ask.create({ data: { checkId: check.id, question: 'can I use the app?', answer: 'Not yet.', askerHandle: null, via: 'WEB', createdAt: new Date(Date.now() - 60_000) } });
  const note1 = await h.prisma.note.create({ data: { checkId: check.id, authorId: user.id, text: 'Dev shipped two earlier tools.', helpful: 12, createdAt: new Date(Date.now() - 7200_000) } });
  const note2 = await h.prisma.note.create({ data: { checkId: check.id, authorId: walletUser.id, text: 'Same template as a rug.', helpful: 3 } });
  await h.prisma.note.create({ data: { checkId: check.id, authorId: user.id, text: 'hidden spam', hidden: true } });
  return { target, prior, check, finishedAt, createdAt, startedAt, ask, ask2, note1, note2, evidence };
}

describe('GET /v1/checks/:id', () => {
  it('maps a fully populated finished coin check to CheckReportDTO', async () => {
    const s = await seedFullCoinCheck();
    const res = await new Client(h.app).get('/v1/checks/full001');
    expect(res.statusCode).toBe(200);
    const r = res.json<CheckReportDTO>();
    const f = s.finishedAt.getTime();
    const expected: CheckReportDTO = {
      id: 'full001',
      targetId: s.target.id,
      kind: 'coin',
      status: 'done',
      name: '$ORBIT',
      title: 'Orbit',
      ticker: 'ORBIT',
      domain: 'orbitswap.xyz',
      handle: 'orbit_xyz',
      ca: MINT,
      chain: 'sol',
      hue: hueOf(`ca:sol:${MINT}`),
      logo: null,
      narScore: 66,
      coinScore: 55,
      total: 61,
      narBand: 'likely',
      coinBand: 'sketchy',
      hasCoin: true,
      summary: "The app loads but the main flow stops at 'Coming soon'.",
      mc: 1500000,
      vol5m: 12000,
      since: 50,
      spark: [0, 10, -20, 20, 50],
      checks: 4,
      asks: 2,
      via: 'bot',
      by: 'degen_rina',
      mine: false,
      createdAt: s.createdAt.toISOString(),
      checkedAt: s.finishedAt.toISOString(),
      deployer: { address: DEP, chain: 'sol' },
      targetRaw: MINT,
      signals: { launch: 'ok', flow: 'warn', docs: 'ok', acct: 'warn', git: 'warn' },
      evidence: {
        launch: 'App opened and wallet connect works',
        flow: "Main flow stops at a 'Coming soon' screen",
        docs: '12 pages, last edited 3 days ago',
        git: '1 repo, 14 commits, all within 48h of launch',
        acct: '@orbit_xyz: 7 months old, renamed once',
      },
      areas: { Product: 75, Claims: 62, People: 50 },
      coinSummary: 'Holders are somewhat concentrated.',
      claims: [
        { text: 'Live on Solana mainnet', source: 'site_hero', sourceLabel: 'From the site hero', kind: 'mainnet', status: 'seen_working', result: 'seen_working', label: 'Seen working', signal: 'ok', evidence: 'App opened (step 2)', stepIdx: 2 },
        { text: 'Fair launch, no team bundle', source: 'x_bio', sourceLabel: 'From the X bio', kind: 'fair_launch', status: 'checks_out', result: 'checks_out', label: 'Checks out', signal: 'ok', evidence: '3% bundled', stepIdx: null },
        { text: 'AI agent trades for you', source: 'docs', sourceLabel: 'From the docs', kind: 'ai_agent', status: 'not_seen', result: 'not_seen', label: 'Not seen', signal: 'warn', evidence: 'Coming soon', stepIdx: 1 },
        { text: 'Open-source code', source: 'footer', sourceLabel: 'From the site footer', kind: 'open_source', status: 'contradicted', result: 'contradicted', label: 'Contradicted', signal: 'fail', evidence: 'No repo', stepIdx: null },
      ],
      steps: [
        { idx: 0, t: 0, status: 'info', text: 'Contract on Solana: 7xKXt…gAsU', source: null, url: null, caption: null, screenshot: null },
        { idx: 1, t: 3200, status: 'ok', text: 'Website from token metadata: orbitswap.xyz', source: 'DexScreener', url: null, caption: null, screenshot: null },
        { idx: 2, t: 9100, status: 'info', text: 'Opening orbitswap.xyz in a clean browser', source: null, url: 'https://orbitswap.xyz', caption: 'Loading page', screenshot: `/shots/${s.check.id}/2.jpg` },
      ],
      stepsExpected: 3,
      progress: 1,
      narrative: { verdict: 'LIKELY_REAL', score: 66 },
      coin: {
        verdict: 'SKETCHY',
        score: 55,
        sig: { deployer: 'warn', bundle: 'ok', holders: 'warn', lp: 'warn', authorities: 'ok' },
        bundlePct: 3.2,
        bundleWallets: 5,
        top10Pct: 31,
        devHoldPct: 4.1,
        lpStatus: 'locked:30',
        lpLabel: 'Locked 30 days',
        authorities: 'Renounced',
        holders: 2140,
        liquidityUsd: 84000.5,
        pairCreatedAt: '2026-10-10T12:00:00.000Z',
        deployerAddress: DEP,
        deployerHistory: {
          total: 1,
          coins: [{ id: 'prior01', ticker: 'PRIOR', name: '$PRIOR', hue: hueOf(`ca:sol:${PRIOR_MINT}`), logo: null, coinScore: 62, coinBand: 'ok' }],
        },
        deployerText: '1 other coin from this wallet checked by ApeCheck, $PRIOR',
      },
      market: {
        priceAtCheck: 0.001,
        mcAtCheck: 1000000,
        priceNow: 0.0015,
        mc: 1500000,
        vol5m: 12000,
        since: 50,
        ch24: -3.5,
        spark: [0, 10, -20, 20, 50],
        series: [
          { t: new Date(f).toISOString(), pct: 0 },
          { t: new Date(f + 3600_000).toISOString(), pct: 10 },
          { t: new Date(f + 2 * 3600_000).toISOString(), pct: -20 },
          { t: new Date(f + 3 * 3600_000).toISOString(), pct: 20 },
          { t: new Date(f + 3 * 3600_000 + 60_000).toISOString(), pct: 50 },
        ],
      },
      people: {
        handle: 'orbit_xyz',
        acct: {
          signal: 'warn',
          createdAt: s.evidence.people!.createdAt!,
          age: '1y 1m',
          followers: 12400,
          followersText: '12.4k',
          verified: false,
          renamed: 'renamed once',
          quality: 'About a third look bought',
        },
        team: { signal: 'warn', text: 'Anonymous, but the dev has a public build history' },
        git: { signal: 'warn', text: '1 repo, 14 commits, all within 48h of launch' },
        docs: { signal: 'ok', text: '12 pages, last edited 3 days ago' },
      },
      asksList: [
        { id: s.ask2.id, question: 'can I use the app?', answer: 'Not yet.', by: null, via: 'site', createdAt: s.ask2.createdAt.toISOString() },
        { id: s.ask.id, question: 'who funded the deployer?', answer: 'Binance hot wallet.', by: 'whalewatch', via: 'x', createdAt: s.ask.createdAt.toISOString() },
      ],
      notes: [
        { id: s.note1.id, by: '@trench_ken', hold: null, text: 'Dev shipped two earlier tools.', helpful: 12, mine: false, createdAt: s.note1.createdAt.toISOString() },
        { id: s.note2.id, by: 'So1an…xxxx', hold: null, text: 'Same template as a rug.', helpful: 3, mine: false, createdAt: s.note2.createdAt.toISOString() },
      ],
      links: { site: 'https://orbitswap.xyz', x: 'https://x.com/orbit_xyz', github: ['https://github.com/orbit/app'], docs: 'https://docs.orbitswap.xyz' },
      durationMs: 150000,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt.toISOString(),
      error: null,
      isPrivate: false,
      cardUrl: `${APP_URL}/card/full001.png`,
      reportUrl: `${APP_URL}/c/full001`,
      report_url: `${APP_URL}/c/full001`,
      post: null,
    };
    expect(r).toEqual(expected);
  });

  it('returns the report shape documented on the /api page (HANDOFF §9)', async () => {
    // the /api example: narrative PARTLY_REAL 48, coin SKETCHY 44, total 46, one claim not_seen, report_url
    const t = await seedTarget(h.prisma, { kind: 'SITE', chain: 'BASE', domain: 'orbitswap.xyz', name: 'orbitswap.xyz', key: 'site:orbitswap.xyz' });
    const c = await seedCheck(h.prisma, {
      targetId: t.id, shortId: 'apidoc1', status: 'DONE', isLatest: true, narScore: 48, narBand: 'partly', coinScore: 44, coinBand: 'sketchy',
      totalScore: 46, summary: "The app loads but the main flow stops at 'Coming soon'.", finishedAt: new Date(),
    });
    await h.prisma.claim.create({ data: { checkId: c.id, idx: 0, text: 'Live on Base mainnet', source: 'site_hero', kind: 'mainnet', status: 'NOT_SEEN', evidence: 'Coming soon' } });
    await h.prisma.coinFacts.create({ data: { checkId: c.id, sigDeployer: 'WARN', sigBundle: 'WARN', sigHolders: 'WARN', sigLp: 'WARN', sigAuthorities: 'OK' } });

    const r = (await new Client(h.app).get('/v1/checks/apidoc1')).json<CheckReportDTO>();
    // read the way a client written from the /api example reads it
    const documented = {
      id: r.id,
      narrative: { verdict: r.narrative!.verdict, score: r.narrative!.score },
      coin: { verdict: r.coin!.verdict, score: r.coin!.score },
      total: r.total,
      summary: r.summary,
      claims: r.claims.map(x => ({ text: x.text, result: x.result })),
      report_url: r.report_url,
    };
    expect(documented).toEqual({
      id: 'apidoc1',
      narrative: { verdict: 'PARTLY_REAL', score: 48 },
      coin: { verdict: 'SKETCHY', score: 44 },
      total: 46,
      summary: "The app loads but the main flow stops at 'Coming soon'.",
      claims: [{ text: 'Live on Base mainnet', result: 'not_seen' }],
      report_url: `${APP_URL}/c/apidoc1`,
    });
    // the web's fields stay: the facts sit next to the verdict, the camelCase keys are still there
    expect(r.coin).toMatchObject({ sig: { deployer: 'warn', authorities: 'ok' }, lpLabel: 'Unknown', deployerAddress: null, deployerHistory: null, deployerText: null });
    expect(r).toMatchObject({ narScore: 48, narBand: 'partly', coinScore: 44, coinBand: 'sketchy', reportUrl: r.report_url });
    expect(r.claims[0].status).toBe('not_seen');
  });

  it('names every narrative and coin band with the /api verdict enum', async () => {
    const nar: [number, string | null, string][] = [
      [90, 'real', 'REAL'], [70, 'likely', 'LIKELY_REAL'], [48, 'partly', 'PARTLY_REAL'], [25, 'llarp', 'LIKELY_LARP'], [5, 'larp', 'LARP'],
      // a row saved without a band: the score's band
      [65, null, 'LIKELY_REAL'],
    ];
    for (const [score, band, verdict] of nar) expect(narrativeOf(score, band)).toEqual({ verdict, score });
    expect(narrativeOf(null, 'partly')).toBeNull();

    const coin: [number | null, string | null, string | null][] = [
      [90, 'clean', 'CLEAN'], [70, 'ok', 'OK'], [44, 'sketchy', 'SKETCHY'], [10, 'rigged', 'RIGGED'], [40, null, 'SKETCHY'], [null, null, null],
    ];
    for (const [score, band, verdict] of coin) expect(coinVerdictOf(score, band)).toBe(verdict);
  });

  it('shows a deployer wallet with its history from ApeCheck: no other coin yet', async () => {
    const t = await seedTarget(h.prisma, { kind: 'COIN', chain: 'BASE', ca: '0x' + 'ab'.repeat(20), ticker: 'NOHIST', name: '$NOHIST', key: `ca:base:0x${'ab'.repeat(20)}` });
    const c = await seedCheck(h.prisma, { targetId: t.id, shortId: 'nohist1', status: 'DONE', isLatest: true, narScore: 40, coinScore: 50, totalScore: 45, narBand: 'partly', coinBand: 'sketchy', finishedAt: new Date() });
    const creator = '0x' + 'cd'.repeat(20);
    await h.prisma.coinFacts.create({
      data: { checkId: c.id, deployerAddress: creator, sigDeployer: 'WARN', sigBundle: 'WARN', sigHolders: 'WARN', sigLp: 'WARN', sigAuthorities: 'OK', authorities: 'Mint renounced' },
    });
    const r = (await new Client(h.app).get('/v1/checks/nohist1')).json<CheckReportDTO>();
    expect(r.deployer).toEqual({ address: creator, chain: 'base' });
    expect(r.coin).toMatchObject({ deployerAddress: creator, deployerHistory: { total: 0, coins: [] }, deployerText: 'no earlier launches seen by ApeCheck' });
    expect(r.coin).not.toHaveProperty('deployer');
    expect(await h.prisma.deployer.count()).toBe(0);
  });

  it("deployer history from ApeCheck's own checks: same chain, public, other coins only, newest first", async () => {
    const W = '0x' + 'cd'.repeat(20);
    const coin = async (key: string, o: { ticker: string; ca?: string; chain?: 'BASE' | 'ETH'; kind?: 'COIN' | 'SITE'; isPrivate?: boolean; agoH?: number; wallet?: string }) => {
      const ca = o.ca ?? '0x' + key.padStart(40, '0');
      const t = await seedTarget(h.prisma, {
        kind: o.kind ?? 'COIN', chain: o.chain ?? 'BASE', ca, ticker: o.ticker, name: o.kind === 'SITE' ? `${key}.xyz` : `$${o.ticker}`, domain: o.kind === 'SITE' ? `${key}.xyz` : null, key: `k:${key}`,
      });
      const c = await seedCheck(h.prisma, {
        targetId: t.id, shortId: `dh${key}`.padEnd(7, '0').slice(0, 7), status: 'DONE', isPrivate: o.isPrivate ?? false, isLatest: !o.isPrivate, coinScore: 50, coinBand: 'sketchy',
        finishedAt: new Date(Date.now() - (o.agoH ?? 1) * 3600_000),
      });
      await seedCoinFacts(h.prisma, c.id, { deployerAddress: o.wallet ?? W });
      return { t, c, ca };
    };
    const self = await coin('11', { ticker: 'SELF', agoH: 0 });
    await coin('12', { ticker: 'SELFSITE', kind: 'SITE', ca: self.ca.toUpperCase().replace('0X', '0x') });
    await coin('13', { ticker: 'OLDER', agoH: 5 });
    await coin('14', { ticker: 'NEWER', agoH: 2 });
    await coin('15', { ticker: 'PRIV', isPrivate: true });
    await coin('16', { ticker: 'ONETH', chain: 'ETH' });
    await coin('17', { ticker: 'OTHERW', wallet: '0x' + 'ee'.repeat(20) });
    const r = (await new Client(h.app).get(`/v1/checks/${self.c.shortId}`)).json<CheckReportDTO>();
    expect(r.coin?.deployerHistory?.coins.map(c => c.ticker)).toEqual(['NEWER', 'OLDER']);
    expect(r.coin?.deployerHistory?.total).toBe(2);
    expect(r.coin?.deployerText).toBe('2 other coins from this wallet checked by ApeCheck, $NEWER and $OLDER');
  });

  it('checks stored before ApeCheck dropped its third-party coin sources load in ApeCheck\'s own words, for every viewer', async () => {
    const t = await seedTarget(h.prisma, { kind: 'COIN', chain: 'SOL', ca: MINT, ticker: 'OLD', name: '$OLD', key: `ca:sol:${MINT}` });
    const c = await seedCheck(h.prisma, {
      targetId: t.id, shortId: 'legacy1', status: 'DONE', isLatest: true, narScore: 48, narBand: 'partly', coinScore: 40, coinBand: 'sketchy', finishedAt: new Date(),
      summary: 'DevRadar was unavailable; the app loads.',
      coinSummary: 'None of the coin data was available',
      evidence: {
        launch: 'App opened',
        clusters: [{ label: 'Launch snipers', wallets: 14, pct: 12.4, fundedFrom: '0x9a1f00000000000000000000000000000000c0de' }],
        stubbed: ['x', 'fourtis'],
      },
    });
    // the exact lines the worker stored back then, with their source tags
    await h.prisma.checkStep.createMany({
      data: [
        { checkId: c.id, idx: 0, tMs: 0, status: 'INFO', text: 'Contract on Solana: 7xKXt…gAsU', source: null },
        { checkId: c.id, idx: 1, tMs: 10, status: 'WARN', text: 'DevRadar unavailable, deployer history unknown', source: 'DevRadar' },
        { checkId: c.id, idx: 2, tMs: 20, status: 'WARN', text: 'DevRadar unavailable, deployer history unknown (0xAbC…Ef02)', source: 'DevRadar' },
        { checkId: c.id, idx: 3, tMs: 30, status: 'WARN', text: 'BundleScan unavailable, bundle share unknown', source: 'BundleScan' },
        { checkId: c.id, idx: 4, tMs: 40, status: 'WARN', text: 'WhaleFlow unavailable, holder share unknown (Solana RPC unavailable)', source: 'WhaleFlow' },
        { checkId: c.id, idx: 5, tMs: 50, status: 'WARN', text: 'Launch: 12.4% of supply bought by 7 bundled wallets', source: 'BundleScan' },
        { checkId: c.id, idx: 6, tMs: 60, status: 'OK', text: 'Authorities: Renounced', source: 'On-chain' },
      ],
    });
    await h.prisma.claim.create({ data: { checkId: c.id, idx: 0, text: 'Fair launch', source: 'site_hero', kind: 'fair_launch', status: 'NOT_SEEN', evidence: 'BundleScan had no launch data' } });
    await h.prisma.ask.create({ data: { checkId: c.id, question: 'bundled?', answer: 'WhaleFlow data was not available for this check.', via: 'WEB' } });
    // a row only the retired service wrote
    const dep = await h.prisma.deployer.create({ data: { chain: 'SOL', address: DEP, record: 'MIXED', launched: 6, dead: 2, fundedFrom: 'Binance' } });
    await seedCoinFacts(h.prisma, c.id, { deployerId: dep.id, deployerAddress: DEP, bundlePct: 12.4, bundleWallets: 7, sigBundle: 'WARN' });

    const expectedSteps = [
      ['Contract on Solana: 7xKXt…gAsU', null],
      ['Deployer history: not checked', null],
      ['Deployer history: not checked (0xAbC…Ef02)', null],
      ['Bundle share: not checked', null],
      ['Holder share: not checked (Solana RPC unavailable)', null],
      ['Launch: 12.4% of supply bought by 7 bundled wallets', null],
      ['Authorities: Renounced', 'On-chain'],
    ];
    const pro = new Client(h.app);
    await signedIn(pro, proW);
    const max = new Client(h.app);
    await signedIn(max, maxW);
    const free = new Client(h.app);
    await signedIn(free, new EvmWallet());
    for (const viewer of [new Client(h.app), free, pro, max]) {
      const res = await viewer.get('/v1/checks/legacy1');
      expect(res.statusCode).toBe(200);
      // the same public report for every tier, so nothing viewer-specific to keep out of caches
      expect(res.headers['cache-control']).toBeUndefined();
      const r = res.json<CheckReportDTO>();
      expect(r.steps.map(s => [s.text, s.source])).toEqual(expectedSteps);
      expect(r.coin).not.toHaveProperty('clusters');
      expect(r.coin).toMatchObject({ bundlePct: 12.4, bundleWallets: 7, deployerAddress: DEP, deployerHistory: { total: 0, coins: [] } });
      expect(r.summary).toBe('The deployer lookup was unavailable; the app loads.');
      expect(r.claims[0].evidence).toBe('The bundle lookup had no launch data');
      expect(r.asksList[0].answer).toBe('The holder lookup data was not available for this check.');
      expect(JSON.stringify(r)).not.toMatch(/fourtis|devradar|bundlescan|whaleflow/i);
    }
    // the SSE replay and its "done" report read the same way
    const events = parseSse((await pro.get('/v1/checks/legacy1/events')).body);
    const steps = events.filter(e => e.event === 'step').map(e => e.data as { text: string; source: string | null });
    expect(steps.map(s => [s.text, s.source])).toEqual(expectedSteps);
    expect(JSON.stringify(events)).not.toMatch(/fourtis|devradar|bundlescan|whaleflow/i);
  });

  it('carries the X post a post check read (evidence.post)', async () => {
    const t = await seedTarget(h.prisma, { kind: 'POST', handle: 'kairolabs', name: '@kairolabs', key: 'post:1849' });
    const evidence: CheckEvidence = { post: { id: '1849', author: 'kairolabs', authorId: '42', text: 'Kairo v2 is live. Try it.', createdAt: '2026-10-18T10:00:00.000Z' } };
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'post001', status: 'DONE', isLatest: true, narScore: 50, totalScore: 50, narBand: 'partly', evidence: evidence as object, finishedAt: new Date() });
    const r = (await new Client(h.app).get('/v1/checks/post001')).json<CheckReportDTO>();
    // with its X id, which /bot compares to the mention's reply target
    expect(r.post).toEqual({ id: '1849', author: 'kairolabs', text: 'Kairo v2 is live. Try it.', createdAt: '2026-10-18T10:00:00.000Z' });

    const t2 = await seedTarget(h.prisma, { kind: 'POST', handle: 'other', name: '@other', key: 'post:1850' });
    await seedCheck(h.prisma, { targetId: t2.id, shortId: 'post002', status: 'DONE', isLatest: true, narScore: 50, totalScore: 50, narBand: 'partly', evidence: { post: null }, finishedAt: new Date() });
    expect((await new Client(h.app).get('/v1/checks/post002')).json<CheckReportDTO>().post).toBeNull();

    // a post stored without a usable id keeps its text, with a null id
    const t3 = await seedTarget(h.prisma, { kind: 'POST', handle: 'third', name: '@third', key: 'post:1851' });
    await seedCheck(h.prisma, { targetId: t3.id, shortId: 'post003', status: 'DONE', isLatest: true, narScore: 50, totalScore: 50, narBand: 'partly', evidence: { post: { id: 1851, author: 'third', text: 'gm' } }, finishedAt: new Date() });
    expect((await new Client(h.app).get('/v1/checks/post003')).json<CheckReportDTO>().post).toEqual({ id: null, author: 'third', text: 'gm', createdAt: null });
  });

  it('marks the requester\'s own check as mine and hides private checks from everyone else', async () => {
    const owner = new Client(h.app);
    await owner.get('/v1/me');
    const sid = owner.sid(h.app)!;
    const t = await seedTarget(h.prisma);
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'mine001', requesterSid: sid });
    await seedCheck(h.prisma, { targetId: t.id, shortId: 'priv001', requesterSid: sid, isPrivate: true, isLatest: false });

    expect((await owner.get('/v1/checks/mine001')).json<CheckReportDTO>().mine).toBe(true);
    expect((await new Client(h.app).get('/v1/checks/mine001')).json<CheckReportDTO>().mine).toBe(false);

    const own = await owner.get('/v1/checks/priv001');
    expect(own.statusCode).toBe(200);
    expect(own.json<CheckReportDTO>().isPrivate).toBe(true);
    const other = await new Client(h.app).get('/v1/checks/priv001');
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ code: 'not_found', error: "This check doesn't exist or has expired." });
  });

  it('reports a running site check with Redis progress and no card yet', async () => {
    const t = await seedTarget(h.prisma, { kind: 'SITE', domain: 'lumenpad.ai', name: 'lumenpad.ai', key: 'site:lumenpad.ai', checkCount: 1 });
    const c = await seedCheck(h.prisma, { targetId: t.id, shortId: 'run0001', status: 'RUNNING', evidence: { stepsExpected: 9 } });
    await h.prisma.checkStep.create({ data: { checkId: c.id, idx: 0, tMs: 0, status: 'INFO', text: 'Target is a website: lumenpad.ai' } });
    await h.redis.set(progressKey(c.id), '0.37');
    const r = (await new Client(h.app).get('/v1/checks/run0001')).json<CheckReportDTO>();
    expect(r).toMatchObject({
      status: 'running',
      kind: 'site',
      title: 'Lumenpad',
      progress: 0.37,
      stepsExpected: 9,
      cardUrl: null,
      reportUrl: `${APP_URL}/c/run0001`,
      report_url: `${APP_URL}/c/run0001`,
      hasCoin: false,
      narrative: null,
      coin: null,
      market: null,
      checkedAt: null,
      links: { site: 'https://lumenpad.ai', x: null, github: [], docs: null },
      people: { handle: null, acct: { signal: null, age: null, renamed: null } },
    });

    await h.redis.del(progressKey(c.id));
    const fallback = (await new Client(h.app).get('/v1/checks/run0001')).json<CheckReportDTO>();
    expect(fallback.progress).toBeCloseTo(1 / 9);
  });

  it('404s unknown and malformed ids', async () => {
    const c = new Client(h.app);
    expect((await c.get('/v1/checks/nope123')).statusCode).toBe(404);
    expect((await c.get('/v1/checks/..%2f..%2fetc')).statusCode).toBe(404);
  });
});

describe('mapper helpers', () => {
  it('derives the prototype title for each kind', () => {
    const base = { ticker: null, handle: null, domain: null, name: 'n' };
    expect(titleOf({ ...base, kind: 'COIN', ticker: 'ORBIT' })).toBe('Orbit');
    expect(titleOf({ ...base, kind: 'POST', handle: 'kairolabs' })).toBe('Kairo');
    expect(titleOf({ ...base, kind: 'POST', handle: 'prismfi_' })).toBe('Prism');
    expect(titleOf({ ...base, kind: 'POST', handle: 'orbit_xyz' })).toBe('Orbit');
    expect(titleOf({ ...base, kind: 'POST', handle: 'pylonhq' })).toBe('Pylon');
    expect(titleOf({ ...base, kind: 'POST', handle: 'labs' })).toBe('Labs');
    expect(titleOf({ ...base, kind: 'POST', name: 'X post' })).toBe('X post');
    expect(titleOf({ ...base, kind: 'SITE', domain: 'orbitswap.xyz' })).toBe('Orbitswap');
    expect(titleOf({ ...base, kind: 'COIN', name: '0xabc…ef01' })).toBe('0xabc…ef01');
  });

  it('words handle renames like the prototype', () => {
    expect(renamedText(null)).toBeNull();
    expect(renamedText(0)).toBe('never renamed');
    expect(renamedText(1)).toBe('renamed once');
    expect(renamedText(3)).toBe('renamed 3 times');
  });

  it('builds /shots/ URLs only for paths inside SCREENSHOT_DIR', () => {
    expect(shotUrl('abc/1.jpg', '/var/shots')).toBe('/shots/abc/1.jpg');
    expect(shotUrl('/shots/abc/1.jpg', '/var/shots')).toBe('/shots/abc/1.jpg');
    expect(shotUrl('/var/shots/abc/1.jpg', '/var/shots')).toBe('/shots/abc/1.jpg');
    expect(shotUrl('/etc/passwd', '/var/shots')).toBeNull();
    expect(shotUrl('abc/../../x.jpg', '/var/shots')).toBeNull();
    expect(shotUrl(null, '/var/shots')).toBeNull();
  });
});
