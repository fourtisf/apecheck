import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hueOf, progressKey, type CheckEvidence, type CheckReportDTO } from '@apecheck/core';
import { Client, APP_URL, makeHarness, resetState, seedCheck, seedTarget, type Harness } from './helpers';
import { renamedText, shotUrl, titleOf } from '../src/mappers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetState(h);
});

const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const DEP = 'DevWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxxxxxx';

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
  const deployer = await h.prisma.deployer.create({
    data: { chain: 'SOL', address: DEP, record: 'MIXED', launched: 6, dead: 2, fundedFrom: 'Binance hot wallet', firstSeen: new Date('2025-02-01T00:00:00Z') },
  });
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
  await h.prisma.claim.createMany({
    data: [
      { checkId: check.id, text: 'Live on Solana mainnet', source: 'site_hero', kind: 'mainnet', status: 'SEEN_WORKING', evidence: 'App opened (step 2)', stepIdx: 2 },
      { checkId: check.id, text: 'Fair launch, no team bundle', source: 'x_bio', kind: 'fair_launch', status: 'CHECKS_OUT', evidence: '3% bundled', stepIdx: null },
      { checkId: check.id, text: 'AI agent trades for you', source: 'docs', kind: 'ai_agent', status: 'NOT_SEEN', evidence: 'Coming soon', stepIdx: 1 },
      { checkId: check.id, text: 'Open-source code', source: 'footer', kind: 'open_source', status: 'CONTRADICTED', evidence: 'No repo', stepIdx: null },
    ],
  });
  await h.prisma.coinFacts.create({
    data: {
      checkId: check.id,
      deployerId: deployer.id,
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
  return { target, deployer, check, finishedAt, createdAt, startedAt, ask, ask2, note1, note2, evidence };
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
      deployer: { address: DEP, chain: 'sol', record: 'mixed' },
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
        { text: 'Live on Solana mainnet', source: 'site_hero', sourceLabel: 'From the site hero', kind: 'mainnet', status: 'seen_working', label: 'Seen working', signal: 'ok', evidence: 'App opened (step 2)', stepIdx: 2 },
        { text: 'Fair launch, no team bundle', source: 'x_bio', sourceLabel: 'From the X bio', kind: 'fair_launch', status: 'checks_out', label: 'Checks out', signal: 'ok', evidence: '3% bundled', stepIdx: null },
        { text: 'AI agent trades for you', source: 'docs', sourceLabel: 'From the docs', kind: 'ai_agent', status: 'not_seen', label: 'Not seen', signal: 'warn', evidence: 'Coming soon', stepIdx: 1 },
        { text: 'Open-source code', source: 'footer', sourceLabel: 'From the site footer', kind: 'open_source', status: 'contradicted', label: 'Contradicted', signal: 'fail', evidence: 'No repo', stepIdx: null },
      ],
      steps: [
        { idx: 0, t: 0, status: 'info', text: 'Contract on Solana: 7xKXt…gAsU', source: null, url: null, caption: null, screenshot: null },
        { idx: 1, t: 3200, status: 'ok', text: 'Website from token metadata: orbitswap.xyz', source: 'DexScreener', url: null, caption: null, screenshot: null },
        { idx: 2, t: 9100, status: 'info', text: 'Opening orbitswap.xyz in a clean browser', source: null, url: 'https://orbitswap.xyz', caption: 'Loading page', screenshot: `/shots/${s.check.id}/2.jpg` },
      ],
      stepsExpected: 3,
      progress: 1,
      coin: {
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
        deployer: {
          id: s.deployer.id,
          chain: 'sol',
          address: DEP,
          record: 'mixed',
          launched: 6,
          dead: 2,
          fundedFrom: 'Binance hot wallet',
          firstSeen: '2025-02-01T00:00:00.000Z',
        },
        deployerText: '6 earlier tokens, 2 dead',
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
        { id: s.note1.id, by: 'trench_ken', hold: null, text: 'Dev shipped two earlier tools.', helpful: 12, mine: false, createdAt: s.note1.createdAt.toISOString() },
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
    };
    expect(r).toEqual(expected);
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
      hasCoin: false,
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
