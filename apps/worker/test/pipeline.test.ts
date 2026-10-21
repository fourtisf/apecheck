/**
 * Full pipeline run(checkId) on fixture sites: real Postgres (test db), Redis db 2, real Chromium behind the
 * SSRF guard proxy, FakeSources for every external data source, heuristic AI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_CHANNEL,
  claimStatusFromDb,
  progressKey,
  scoreCheck,
  scoreCoin,
  sigFromDb,
  type CheckChannelMsg,
  type CheckEvidence,
  type LiveChannelMsg,
  type Signal,
} from '@apecheck/core';
import { BrowserHost } from '../src/browser/browser';
import { loadAnswerData } from '../src/ai';
import { memoryLogger } from '../src/log';
import { recoverStaleChecks, runCheck, type PipelineDeps } from '../src/pipeline';
import { challengeHandler, closedPort, serveFixture, serveHandler, testLookup, type FixtureSite } from './fixture-server';
import { dexInfo, fakeSources, repoFacts, xUser, type FakeData } from './fakes';
import { createCheck, heuristicAi, prisma, resetDb, testEnv } from './helpers';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const COIN = '0x1111111111111111111111111111111111111111';

let host: BrowserHost;
let env: ReturnType<typeof testEnv>;
let redis: Redis;
let sub: Redis;
const sites = new Map<string, FixtureSite>();
let neverHost: string;
const messages: { channel: string; msg: unknown }[] = [];
const botReplies: string[] = [];

function deps(data: FakeData = {}): PipelineDeps {
  return {
    env,
    prisma,
    redis,
    sources: fakeSources(env, data),
    ai: heuristicAi(),
    browser: async () => host,
    log: memoryLogger(),
    fetchCard: async () => PNG,
    hooks: { enqueueBotReply: async id => void botReplies.push(id) },
  };
}

const workingData = (): FakeData => ({
  repos: { 'orbitswap/core': [repoFacts({ fullName: 'orbitswap/core' })] },
  users: { orbitswap: xUser({ handle: 'orbitswap' }) },
});

beforeAll(async () => {
  for (const n of ['working-app', 'waitlist', 'dead-button', 'coming-soon-connect', 'waitlist-connect', 'dead-launch-connect', 'dialog-swap', 'nul-text']) {
    sites.set(n, await serveFixture(n));
  }
  sites.set('cf-challenge', await serveHandler('cf-challenge', challengeHandler('challenge')));
  neverHost = `never-loads.test:${await closedPort()}`;
  env = testEnv({ SSRF_ALLOW_HOSTS: [...[...sites.values()].map(s => s.host), neverHost].join(',') });
  host = await BrowserHost.launch({ env, lookup: testLookup });
  redis = new Redis(process.env.REDIS_URL!);
  sub = new Redis(process.env.REDIS_URL!);
  sub.on('pmessage', (_p, channel, raw) => messages.push({ channel, msg: JSON.parse(raw) }));
  await sub.psubscribe('check:*');
  await sub.subscribe(LIVE_CHANNEL);
  sub.on('message', (channel, raw) => messages.push({ channel, msg: JSON.parse(raw) }));
});

afterAll(async () => {
  await host?.close();
  for (const s of sites.values()) await s.close();
  await sub?.quit();
  await redis?.quit();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  messages.length = 0;
  botReplies.length = 0;
});

async function stored(checkId: string) {
  return prisma.check.findUniqueOrThrow({
    where: { id: checkId },
    include: { steps: { orderBy: { idx: 'asc' } }, claims: { orderBy: { idx: 'asc' } }, coinFacts: { include: { deployer: true } }, target: true },
  });
}

function recomputed(c: Awaited<ReturnType<typeof stored>>) {
  const s = (v: string | null) => sigFromDb(v) as Signal;
  const coin = c.coinFacts
    ? {
        deployer: (c.coinFacts.deployer?.record.toLowerCase() as 'builder' | 'mixed' | 'serial') ?? 'mixed',
        bundle: s(c.coinFacts.sigBundle),
        holders: s(c.coinFacts.sigHolders),
        lp: s(c.coinFacts.sigLp),
        authorities: s(c.coinFacts.sigAuthorities),
      }
    : undefined;
  return scoreCheck(
    { launch: s(c.sigLaunch), flow: s(c.sigFlow), docs: s(c.sigDocs), acct: s(c.sigAcct), git: s(c.sigGit), claims: c.claims.map(x => claimStatusFromDb(x.status)) },
    coin,
  );
}

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 50));
};

describe('pipeline run(checkId)', () => {
  it('website without a coin: steps, screenshots, scores, Redis, progress, card, isLatest', async () => {
    const url = sites.get('working-app')!.url;
    const check = await createCheck(url);
    const res = await runCheck(check.id, deps(workingData()));
    expect(res.status).toBe('done');

    const c = await stored(check.id);
    expect(c.status).toBe('DONE');
    expect(c.isLatest).toBe(true);
    expect(c.finishedAt).not.toBeNull();
    expect(c.durationMs).toBeGreaterThan(0);

    // steps are contiguous and in order, with screenshots on disk
    expect(c.steps.map(s => s.idx)).toEqual(c.steps.map((_, i) => i));
    expect(c.steps[0].text).toBe('Target is a website: working-app.test');
    const texts = c.steps.map(s => s.text);
    const at = (re: RegExp) => texts.findIndex(t => re.test(t));
    expect(at(/^Opening working-app\.test in a clean browser$/)).toBeLessThan(at(/^Page loaded in/));
    expect(at(/^Page loaded in/)).toBeLessThan(at(/^'Launch app' opens/));
    expect(at(/simulation succeeded/)).toBeLessThan(at(/^Docs: /));
    expect(at(/^Docs: /)).toBeLessThan(at(/^Pulled \d+ claims/));
    expect(at(/^GitHub: 412 commits, last push 2 days ago$/)).toBeGreaterThan(at(/^Pulled/));
    expect(at(/^@orbitswap: 2y \d+m old, 41\.2k followers$/)).toBeGreaterThan(at(/^GitHub:/));
    expect(texts[texts.length - 1]).toMatch(/^Scoring \d+ claims$/);
    const shots = c.steps.filter(s => s.screenshot);
    expect(shots.length).toBeGreaterThanOrEqual(4);
    for (const s of shots) {
      expect(s.screenshot).toBe(`${check.id}/${s.idx}.jpg`);
      expect(fs.existsSync(path.join(env.SCREENSHOT_DIR, s.screenshot!))).toBe(true);
    }
    expect(shots.every(s => s.caption)).toBe(true);
    expect(c.steps.find(s => s.source === 'GitHub')).toBeTruthy();

    // signals, claims and deterministic scores
    expect([sigFromDb(c.sigLaunch), sigFromDb(c.sigFlow), sigFromDb(c.sigDocs), sigFromDb(c.sigAcct), sigFromDb(c.sigGit)]).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(c.claims.length).toBeGreaterThanOrEqual(3);
    // claims keep the extraction order (Claim.idx 0..n-1), which the API sorts by
    expect(c.claims.map(x => x.idx)).toEqual(c.claims.map((_, i) => i));
    const r = recomputed(c);
    expect(c.narScore).toBe(r.narrative.score);
    expect(c.totalScore).toBe(r.total);
    expect(c.narBand).toBe(r.narrative.band.key);
    expect(c.areas).toEqual(r.narrative.areas);
    expect(c.coinScore).toBeNull();
    expect(c.summary).toMatch(/^The app works end to end; code is public and active\.$/);
    const ev = c.evidence as CheckEvidence;
    expect(ev.site?.loaded).toBe(true);
    expect(ev.site?.wallet?.tx?.simulated).toBe('ok');
    expect(ev.ai?.mode).toBe('heuristic');
    expect(ev.stepsExpected).toBe(10);
    expect(ev.docsInfo?.pages).toBeGreaterThanOrEqual(3);
    expect(ev.github?.found).toBe(true);
    expect(ev.links?.x).toBe('https://x.com/orbitswap');

    // target fields
    expect(c.target.key).toBe('site:working-app.test');
    expect(c.target.handle).toBe('orbitswap');
    expect(c.target.lastCheckedAt).not.toBeNull();

    // share card
    expect(c.cardPath).toBe(`cards/${c.shortId}.png`);
    expect(fs.readFileSync(path.join(env.SCREENSHOT_DIR, c.cardPath!))).toEqual(PNG);

    // Redis: every step published in order, then done; live start/end; progress at 1
    await waitFor(() => messages.some(m => m.channel === LIVE_CHANNEL && (m.msg as LiveChannelMsg).type === 'end'));
    const mine = messages.filter(m => m.channel === `check:${check.id}`).map(m => m.msg as CheckChannelMsg);
    const stepMsgs = mine.filter((m): m is Extract<CheckChannelMsg, { type: 'step' }> => m.type === 'step');
    expect(stepMsgs.map(m => m.step.idx)).toEqual(c.steps.map(s => s.idx));
    expect(stepMsgs.find(m => m.step.screenshot)?.step.screenshot).toMatch(new RegExp(`^/shots/${check.id}/\\d+\\.jpg$`));
    const progress = stepMsgs.map(m => m.progress);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(mine[mine.length - 1]).toEqual({ type: 'done', status: 'done' });
    const live = messages.filter(m => m.channel === LIVE_CHANNEL).map(m => m.msg as LiveChannelMsg);
    expect(live).toEqual([
      { type: 'start', checkId: check.id, shortId: check.shortId },
      { type: 'end', checkId: check.id, shortId: check.shortId },
    ]);
    expect(await redis.get(progressKey(check.id))).toBe('1');
    expect(await redis.ttl(progressKey(check.id))).toBeGreaterThan(3000);

    // a second check on the same target takes over isLatest
    const again = await createCheck(url);
    expect((await runCheck(again.id, deps(workingData()))).status).toBe('done');
    const [first, second] = await Promise.all([stored(check.id), stored(again.id)]);
    expect(first.isLatest).toBe(false);
    expect(second.isLatest).toBe(true);
    expect(second.target.checkCount).toBe(2);
  });

  it("a Max user's private check of a public target never takes or clears its public latest verdict", async () => {
    const url = sites.get('working-app')!.url;
    const pub = await createCheck(url);
    expect((await runCheck(pub.id, deps(workingData()))).status).toBe('done');
    const before = await stored(pub.id);
    expect(before.isLatest).toBe(true);
    const user = await prisma.user.create({ data: { evmAddress: '0x' + '7'.repeat(40), tier: 'MAX' } });
    // db createCheck: a private check does not count towards the public checkCount
    const priv = await prisma.check.create({
      data: { shortId: 'priv001', targetId: pub.targetId, targetRaw: url, status: 'QUEUED', isPrivate: true, requesterId: user.id },
    });
    expect((await runCheck(priv.id, deps(workingData()))).status).toBe('done');
    const [a, b] = await Promise.all([stored(pub.id), stored(priv.id)]);
    expect(b.status).toBe('DONE');
    expect(b.isLatest).toBe(false);
    expect(a.isLatest).toBe(true);
    expect(b.target.lastCheckedAt?.toISOString()).toBe(before.target.lastCheckedAt?.toISOString());
    expect(b.target.checkCount).toBe(before.target.checkCount);
    expect(await prisma.check.count({ where: { targetId: pub.targetId, isLatest: true } })).toBe(1);
  });

  it('EVM coin: chain detected, site from token info, coin facts, Deployer upsert, PricePoint, re-keyed Target', async () => {
    const url = sites.get('working-app')!.url;
    // an earlier check already owns the canonical key: the new check is re-pointed to it
    const existing = await prisma.target.create({ data: { key: `ca:base:${COIN}`, kind: 'COIN', chain: 'BASE', ca: COIN, name: '$ORBIT', checkCount: 1 } });
    const check = await createCheck(COIN);
    const data: FakeData = {
      ...workingData(),
      evmChains: { [COIN]: 'base' },
      dexTokens: {
        [COIN]: dexInfo({ chain: 'base', address: COIN, websites: [url], socials: [{ type: 'twitter', url: 'https://x.com/orbitswap' }] }),
      },
      coinFacts: {
        [COIN]: {
          chain: 'base', address: COIN, token: { name: 'Orbit', symbol: 'ORBIT', decimals: 18, supply: '1000000000' },
          deployer: { address: '0xAbCd00000000000000000000000000000000Ef01', fundedFrom: 'Coinbase', launched: 3, dead: 2, firstSeen: '2025-01-02T00:00:00Z', source: 'DevRadar' },
          bundle: { pct: 12.4, wallets: 7, source: 'BundleScan' },
          holders: { top10Pct: 31, devHoldPct: 2, count: 1840, source: 'WhaleFlow' },
          lp: { status: 'burned', lockedDays: null, source: 'On-chain' },
          authorities: { mintRenounced: true, freezeActive: false, owner: null, text: 'Renounced', source: 'On-chain' },
          market: null, stubbed: [], errors: [],
        },
      },
    };
    const res = await runCheck(check.id, deps(data));
    expect(res.status).toBe('done');
    const c = await stored(check.id);
    expect(c.targetId).toBe(existing.id);
    expect(await prisma.target.count({ where: { key: `ca:evm:${COIN}` } })).toBe(0);
    expect(c.target.checkCount).toBe(2);
    expect(c.target.name).toBe('$ORBIT');
    expect(c.target.domain).toBe('working-app.test');
    expect(c.target.handle).toBe('orbitswap');

    const texts = c.steps.map(s => s.text);
    expect(texts[0]).toBe('Contract on Base: 0x111…1111');
    expect(texts[1]).toBe('Website from token metadata: working-app.test');
    expect(texts).toContain('Deployer: 3 earlier tokens, 2 dead');
    expect(texts).toContain('Launch: 12.4% of supply bought by 7 bundled wallets');
    expect(texts).toContain('Top 10 holders own 31%, dev wallet 2%, liquidity burned');
    expect(texts[texts.length - 1]).toMatch(/^Scoring \d+ claims and the coin$/);
    expect(c.steps.find(s => s.text.startsWith('Launch:'))?.source).toBe('BundleScan');

    const f = c.coinFacts!;
    expect([f.sigDeployer, f.sigBundle, f.sigHolders, f.sigLp, f.sigAuthorities]).toEqual(['WARN', 'WARN', 'WARN', 'OK', 'OK']);
    expect(f.lpStatus).toBe('burned');
    expect(f.deployer).toMatchObject({ chain: 'BASE', address: '0xabcd00000000000000000000000000000000ef01', record: 'MIXED', launched: 3, dead: 2, fundedFrom: 'Coinbase' });
    expect(f.deployerAddress).toBe('0xabcd00000000000000000000000000000000ef01');
    expect(c.coinScore).toBe(scoreCoin({ deployer: 'mixed', bundle: 'warn', holders: 'warn', lp: 'ok', authorities: 'ok' }).score);
    const r = recomputed(c);
    expect(c.narScore).toBe(r.narrative.score);
    expect(c.totalScore).toBe(r.total);
    expect(c.coinBand).toBe(r.coin!.band.key);
    expect(c.coinSummary).toBeTruthy();

    expect(Number(c.priceAtCheck)).toBeCloseTo(0.0123, 6);
    expect(Number(c.mcAtCheck)).toBe(1_230_000);
    const points = await prisma.pricePoint.findMany({ where: { targetId: existing.id } });
    expect(points).toHaveLength(1);
    expect(Number(points[0].price)).toBeCloseTo(0.0123, 6);
    expect(Number(c.target.lastPrice)).toBeCloseTo(0.0123, 6);
    expect(c.target.priceUpdatedAt).not.toBeNull();
    expect(c.target.lastCh24).toBe(6.1);

    // follow-up answers (M3 asks / bot) read only the stored check
    const answerData = await loadAnswerData(prisma, check.id);
    expect(await heuristicAi().answer('who funded the deployer?', answerData!)).toBe('The deployer was funded from Coinbase. Track record: 3 earlier tokens, 2 dead.');
  });

  it('a deployer wallet without launch history is kept as an address only: no Deployer row, no counts', async () => {
    const check = await createCheck(COIN);
    const data: FakeData = {
      evmChains: { [COIN]: 'base' },
      coinFacts: {
        [COIN]: {
          chain: 'base', address: COIN, token: { name: 'Orbit', symbol: 'ORBIT', decimals: 18, supply: '1000000000' },
          deployer: { address: '0xAbCd00000000000000000000000000000000Ef02', fundedFrom: null, launched: null, dead: null, firstSeen: null, source: 'On-chain' },
          bundle: null, holders: null, lp: null,
          authorities: { mintRenounced: true, freezeActive: false, owner: null, text: 'Mint renounced', source: 'On-chain' },
          market: null, stubbed: ['fourtis'], errors: [],
        },
      },
    };
    expect((await runCheck(check.id, deps(data))).status).toBe('done');
    const c = await stored(check.id);
    expect(c.coinFacts?.deployerId).toBeNull();
    expect(c.coinFacts?.deployerAddress).toBe('0xabcd00000000000000000000000000000000ef02');
    expect(c.coinFacts?.sigDeployer).toBe('WARN');
    expect(await prisma.deployer.count()).toBe(0);
    expect(c.steps.some(s => s.text === 'Deployer history not checked (0xAbC…Ef02)')).toBe(true);
  });

  it("a Max user's private coin check never creates or refreshes a Deployer row; it links one the public already knows", async () => {
    const user = await prisma.user.create({ data: { evmAddress: '0x' + '8'.repeat(40), tier: 'MAX' } });
    const wallet = '0xabcd00000000000000000000000000000000ef03';
    const data: FakeData = {
      evmChains: { [COIN]: 'base' },
      coinFacts: {
        [COIN]: {
          chain: 'base', address: COIN, token: { name: 'Orbit', symbol: 'ORBIT', decimals: 18, supply: '1000000000' },
          deployer: { address: wallet, fundedFrom: 'Binance', launched: 7, dead: 6, firstSeen: '2025-01-02T00:00:00Z', source: 'DevRadar' },
          bundle: null, holders: null, lp: null,
          authorities: { mintRenounced: true, freezeActive: false, owner: null, text: 'Mint renounced', source: 'On-chain' },
          market: null, stubbed: [], errors: [],
        },
      },
    };
    const privately = async () => {
      const c = await createCheck(COIN);
      await prisma.check.update({ where: { id: c.id }, data: { isPrivate: true, requesterId: user.id } });
      expect((await runCheck(c.id, deps(data))).status).toBe('done');
      return stored(c.id);
    };
    // nobody has seen this wallet in public: no Deployer row (the deployers page would list it), the report keeps it
    const first = await privately();
    expect(await prisma.deployer.count()).toBe(0);
    expect(first.coinFacts).toMatchObject({ deployerId: null, deployerAddress: wallet });
    expect(first.steps.map(s => s.text)).toContain('Deployer: 7 earlier tokens, 6 dead');
    // the public knows the wallet: a private check links that row and leaves its counts alone
    const known = await prisma.deployer.create({ data: { chain: 'BASE', address: wallet, record: 'BUILDER', launched: 1, dead: 0, fundedFrom: 'Coinbase' } });
    const second = await privately();
    expect(second.coinFacts?.deployerId).toBe(known.id);
    expect(await prisma.deployer.findUniqueOrThrow({ where: { id: known.id } })).toMatchObject({ record: 'BUILDER', launched: 1, dead: 0, fundedFrom: 'Coinbase' });
    expect(await prisma.deployer.count()).toBe(1);
  });

  it('M1 acceptance: waitlist and dead-button sites cannot score above Partly real, a wallet connect button included', async () => {
    // a 2-year-old X account and an active repo: everything but the product looks good
    const good: FakeData = {
      repos: { 'helix/core': [repoFacts({ fullName: 'helix/core' })] },
      users: { helix: xUser({ handle: 'helix' }) },
    };
    for (const [name, launch] of [
      ['waitlist', 'WARN'],
      ['dead-button', 'FAIL'],
      // 'Launch app' opens 'Coming soon'; a template header 'Connect wallet' works
      ['coming-soon-connect', 'WARN'],
      // the only button connects the wallet, then shows "You're on the waitlist!"
      ['waitlist-connect', 'WARN'],
      // a dead 'Launch app' next to a working 'Connect wallet'
      ['dead-launch-connect', 'FAIL'],
    ] as const) {
      const check = await createCheck(sites.get(name)!.url);
      expect((await runCheck(check.id, deps(good))).status).toBe('done');
      const c = await stored(check.id);
      expect([name, c.sigLaunch]).toEqual([name, launch]);
      expect(c.narScore!).toBeLessThanOrEqual(58);
      expect(['partly', 'llarp', 'larp']).toContain(c.narBand);
      expect(c.narScore).toBe(recomputed(c).narrative.score);
      const ev = c.evidence as CheckEvidence;
      expect(ev.launch).not.toMatch(/^App opened/);
      expect(c.summary).not.toMatch(/^The app loads/);
    }
  });

  it('a main button that only opens a dialog: flow warn, not "end to end", no AI / mainnet claim seen', async () => {
    const check = await createCheck(sites.get('dialog-swap')!.url);
    const data: FakeData = { repos: { 'vapor/core': [repoFacts({ fullName: 'vapor/core' })] }, users: { vapor: xUser({ handle: 'vapor' }) } };
    expect((await runCheck(check.id, deps(data))).status).toBe('done');
    const c = await stored(check.id);
    expect([c.sigLaunch, c.sigFlow]).toEqual(['OK', 'WARN']);
    expect(c.narScore!).toBeLessThanOrEqual(74);
    expect(c.summary).not.toMatch(/end to end/);
    expect(c.summary).toMatch(/^The app loads but the main flow wasn't completed; /);
    expect(c.steps.some(s => /responded without errors/.test(s.text))).toBe(false);
    const seen = c.claims.filter(x => x.status === 'SEEN_WORKING').map(x => x.kind);
    expect(seen).not.toContain('mainnet');
    expect(seen).not.toContain('ai_agent');
    expect(c.claims.some(x => x.kind === 'ai_agent')).toBe(true);
  });

  it('U+0000 and lone surrogates from the page and from third parties never stop a verdict', async () => {
    const url = sites.get('nul-text')!.url;
    const check = await createCheck(COIN);
    const data: FakeData = {
      evmChains: { [COIN]: 'base' },
      dexTokens: { [COIN]: dexInfo({ chain: 'base', address: COIN, symbol: 'ZE\u0000RO', name: 'Zero\u0000 \ud800', websites: [url], socials: [{ type: 'twitter', url: 'https://x.com/zeroproto' }] }) },
      users: { zeroproto: xUser({ handle: 'zeroproto', name: 'Ze\u0000ro', description: 'The null \u0000 protocol' }) },
      coinFacts: {
        [COIN]: {
          chain: 'base', address: COIN, token: { name: 'Zero\u0000', symbol: 'ZERO', decimals: 18, supply: '1' },
          deployer: { address: '0xAbCd00000000000000000000000000000000Ef03', fundedFrom: 'Bin\u0000ance', launched: 1, dead: 0, firstSeen: null, source: 'DevRadar' },
          bundle: null, holders: null, lp: null,
          authorities: { mintRenounced: true, freezeActive: false, owner: null, text: 'Renounced\u0000', source: 'On-chain' },
          market: null, stubbed: [], errors: [],
        },
      },
    };
    const res = await runCheck(check.id, deps(data));
    expect(res.status).toBe('done');
    const c = await stored(check.id);
    expect(c.status).toBe('DONE');
    expect(c.narScore).not.toBeNull();
    expect(c.error).toBeNull();
    const all = JSON.stringify({ ev: c.evidence, steps: c.steps, claims: c.claims, target: c.target, coin: c.coinFacts, summary: c.summary });
    expect(all).not.toMatch(/\\u0000|\u0000/);
    expect(all).not.toMatch(/\\ud800/i);
    const ev = c.evidence as CheckEvidence;
    // the page's console error and title are kept, minus the character Postgres refuses
    expect(ev.site?.consoleErrors).toEqual(expect.arrayContaining(['boom  here']));
    expect(ev.site?.title).toMatch(/^Zero +protocol/);
    expect(c.target.name).toBe('$ZERO');
    expect(c.coinFacts?.authorities).toBe('Renounced');
    expect(c.coinFacts?.deployer?.fundedFrom).toBe('Binance');
    expect(c.claims.some(x => x.text.startsWith('Live on Base mainnet'))).toBe(true);
  });

  it('a site behind a bot challenge is "could not be checked", never "doesn\'t load" or Likely LARP', async () => {
    const check = await createCheck(sites.get('cf-challenge')!.url);
    expect((await runCheck(check.id, deps())).status).toBe('done');
    const c = await stored(check.id);
    expect([c.sigLaunch, c.sigFlow]).toEqual(['WARN', 'WARN']);
    expect(c.summary).toMatch(/^The site could not be checked this time/);
    expect(c.steps.some(s => /didn't load/.test(s.text))).toBe(false);
    expect(c.steps.some(s => s.text === 'No X account linked to the project')).toBe(false);
    expect(c.steps.some(s => s.status === 'WARN' && s.text === "X account unknown (the site couldn't be read)")).toBe(true);
    expect((c.evidence as CheckEvidence).acct).toBe("X account unknown (the site couldn't be read)");
    expect(['larp', 'llarp']).not.toContain(c.narBand);
  });

  it('an unexpected error stores only the public message, never the exception text', async () => {
    const check = await createCheck(sites.get('waitlist')!.url);
    const d = deps();
    let n = 0;
    const leak = new Error('\nInvalid `tx.check.update()` invocation in\n/home/user/apecheck/apps/worker/src/pipeline/save.ts:152:20\n\n  149 }');
    // the first $transaction claims the run; every save attempt after it fails
    d.prisma = new Proxy(prisma, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (k === '$transaction') return (...a: unknown[]) => (++n > 1 ? Promise.reject(leak) : (v as (...x: unknown[]) => unknown).apply(t, a));
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const res = await runCheck(check.id, d);
    expect(res.status).toBe('failed');
    const c = await stored(check.id);
    expect(c.status).toBe('FAILED');
    expect(c.error).toBe('The check hit an error and could not finish');
    expect(c.steps[c.steps.length - 1]).toMatchObject({ status: 'FAIL', text: 'The check hit an error and could not finish' });
    // the save was tried a second time with minimal evidence before giving up
    expect(n).toBe(3);
  });

  it('a save that fails once is retried with minimal evidence and the verdict is kept', async () => {
    const check = await createCheck(sites.get('waitlist')!.url);
    const d = deps();
    let n = 0;
    d.prisma = new Proxy(prisma, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (k === '$transaction') return (...a: unknown[]) => (++n === 2 ? Promise.reject(new Error('22P05 unsupported Unicode escape sequence')) : (v as (...x: unknown[]) => unknown).apply(t, a));
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    expect((await runCheck(check.id, d)).status).toBe('done');
    const c = await stored(check.id);
    expect(c.status).toBe('DONE');
    const ev = c.evidence as CheckEvidence;
    expect(ev.degraded).toContain('save:retry');
    expect(ev.launch).toBe("'Launch app' opens a waitlist form");
    expect(c.narScore).toBe(recomputed(c).narrative.score);
  });

  it('a site that never loads still finishes, with launch = fail', async () => {
    const check = await createCheck(`http://${neverHost}/`);
    expect((await runCheck(check.id, deps())).status).toBe('done');
    const c = await stored(check.id);
    expect(c.status).toBe('DONE');
    expect(c.sigLaunch).toBe('FAIL');
    expect(c.steps.some(s => s.status === 'FAIL' && /didn't load/.test(s.text))).toBe(true);
    expect(c.summary).toMatch(/^The site doesn't load/);
  });

  it('a bot-triggered check enqueues the reply of every mention still waiting on it', async () => {
    const check = await createCheck(sites.get('waitlist')!.url);
    const mention = (tweetId: string, status: 'QUEUED' | 'IGNORED' | 'REPLIED', authorId: string) =>
      prisma.botMention.create({ data: { tweetId, authorId, authorHandle: `u${authorId}`, text: '@ApeCheckBot check this', checkId: check.id, status, kind: status === 'IGNORED' ? 'ignored' : 'check' } });
    const first = await mention('1849000000000000001', 'QUEUED', '42');
    // another account's tag in the same thread reused the check
    const second = await mention('1849000000000000002', 'QUEUED', '43');
    // a re-tag linked to the check but not answered again, and one already answered
    await mention('1849000000000000003', 'IGNORED', '42');
    await mention('1849000000000000004', 'REPLIED', '44');
    await runCheck(check.id, deps());
    expect(botReplies).toEqual([first.id, second.id]);
  });

  it('an unrecoverable input fails the check with a final fail step and a done message', async () => {
    const t = await prisma.target.create({ data: { key: 'site:broken.example', kind: 'SITE', name: 'broken', checkCount: 1 } });
    const check = await prisma.check.create({ data: { shortId: 'bad0001', targetId: t.id, targetRaw: '¯\\_(ツ)_/¯', status: 'QUEUED' } });
    const res = await runCheck(check.id, deps());
    expect(res.status).toBe('failed');
    const c = await stored(check.id);
    expect(c.status).toBe('FAILED');
    expect(c.error).toMatch(/Couldn't tell what this is/);
    expect(c.steps[c.steps.length - 1].status).toBe('FAIL');
    await waitFor(() => messages.some(m => m.channel === `check:${check.id}` && (m.msg as CheckChannelMsg).type === 'done'));
    expect(messages.find(m => m.channel === `check:${check.id}` && (m.msg as CheckChannelMsg).type === 'done')?.msg).toEqual({ type: 'done', status: 'failed' });
  });

  it('a finished check is not run again', async () => {
    const check = await createCheck(sites.get('waitlist')!.url);
    await prisma.check.update({ where: { id: check.id }, data: { status: 'DONE' } });
    expect((await runCheck(check.id, deps())).status).toBe('skipped');
  });

  it('startup recovery marks checks stuck in RUNNING as FAILED with a log step', async () => {
    const check = await createCheck(sites.get('waitlist')!.url);
    const old = new Date(Date.now() - (env.CHECK_BUDGET_SECONDS * 2 + 60) * 1000);
    await prisma.check.update({ where: { id: check.id }, data: { status: 'RUNNING', startedAt: old } });
    await prisma.checkStep.create({ data: { checkId: check.id, idx: 0, tMs: 10, status: 'INFO', text: 'Target is a website: waitlist.test' } });
    const fresh = await createCheck(sites.get('dead-button')!.url);
    await prisma.check.update({ where: { id: fresh.id }, data: { status: 'RUNNING', startedAt: new Date() } });

    const n = await recoverStaleChecks({ prisma, redis, env, log: memoryLogger() });
    expect(n).toBe(1);
    const c = await stored(check.id);
    expect(c.status).toBe('FAILED');
    expect(c.steps.map(s => [s.idx, s.status])).toEqual([[0, 'INFO'], [1, 'FAIL']]);
    expect(c.steps[1].text).toBe('Check stopped: the worker restarted before it finished');
    expect((await stored(fresh.id)).status).toBe('RUNNING');
  });
});

describe('our own browser failing is not a verdict', () => {
  const NO_BROWSER = /^Our test browser was unavailable/;

  /** FAILED with the retry sentence (Check.error and the last step), no score, nothing published as the project's */
  async function expectNoVerdict(checkId: string) {
    const c = await stored(checkId);
    expect(c.status).toBe('FAILED');
    expect(c.error).toMatch(NO_BROWSER);
    expect(c.steps[c.steps.length - 1]).toMatchObject({ status: 'FAIL' });
    expect(c.steps[c.steps.length - 1].text).toMatch(NO_BROWSER);
    expect([c.narScore, c.narBand, c.sigLaunch]).toEqual([null, null, null]);
    expect(c.isLatest).toBe(false);
    expect(c.steps.some(s => /didn't load/.test(s.text))).toBe(false);
    await waitFor(() => messages.some(m => m.channel === `check:${checkId}` && (m.msg as CheckChannelMsg).type === 'done'));
    expect(messages.find(m => m.channel === `check:${checkId}` && (m.msg as CheckChannelMsg).type === 'done')?.msg).toEqual({ type: 'done', status: 'failed' });
  }

  it('the browser could not start (browse:unavailable): FAILED, never an all-unknown "partly"', async () => {
    const check = await createCheck(sites.get('working-app')!.url);
    const d = deps(workingData());
    d.browser = async () => null;
    expect((await runCheck(check.id, d)).status).toBe('failed');
    await expectNoVerdict(check.id);
  });

  it('the browser failing before the site loaded (browse:error): FAILED', async () => {
    const check = await createCheck(sites.get('working-app')!.url);
    const d = deps(workingData());
    const dead = { newSession: async () => { throw new Error('browser.newContext: Target page, context or browser has been closed'); } };
    d.browser = async () => dead as unknown as BrowserHost;
    expect((await runCheck(check.id, d)).status).toBe('failed');
    await expectNoVerdict(check.id);
  });

  it('the browser cannot reach our SSRF guard (ERR_PROXY_CONNECTION_FAILED): FAILED, the project is not "Likely LARP"', async () => {
    const broken = await BrowserHost.launch({ env, lookup: testLookup });
    try {
      // the guard is gone: Chromium's every request now fails at the proxy, before any site is asked
      await broken.guard!.close();
      const check = await createCheck(sites.get('working-app')!.url);
      const d = deps(workingData());
      d.browser = async () => broken;
      const log = d.log as ReturnType<typeof memoryLogger>;
      expect((await runCheck(check.id, d)).status).toBe('failed');
      await expectNoVerdict(check.id);
      expect(log.lines.some(l => /cannot reach the guard proxy/.test(l))).toBe(true);
    } finally {
      await broken.close();
    }
  });

  it('an https site whose server refuses the connection (the guard answers 502: ERR_TUNNEL_CONNECTION_FAILED) is still scored as not loading', async () => {
    const check = await createCheck(`https://${neverHost}/`);
    const asked = vi.spyOn(host, 'guardProblem');
    try {
      expect((await runCheck(check.id, deps())).status).toBe('done');
      // the failure was at the proxy, so the guard was asked, and it answered: the site's failure, not ours
      expect(asked).toHaveBeenCalledTimes(1);
      await expect(asked.mock.results[0].value).resolves.toBeNull();
    } finally {
      asked.mockRestore();
    }
    const c = await stored(check.id);
    expect(c.status).toBe('DONE');
    expect(c.sigLaunch).toBe('FAIL');
    expect(c.steps.some(s => s.status === 'FAIL' && /didn't load \(could not connect\)/.test(s.text))).toBe(true);
  });
});

describe('stage budget', () => {
  it('a stage that times out is logged and the check still finishes', async () => {
    const check = await createCheck(sites.get('working-app')!.url);
    const d = deps(workingData());
    const slow = d.sources.github.fromUrl.bind(d.sources.github);
    d.sources.github.fromUrl = vi.fn(async (u: string) => {
      await new Promise(r => setTimeout(r, 5000));
      return slow(u);
    });
    d.limits = { evidence: 1500 };
    const res = await runCheck(check.id, d);
    expect(res.status).toBe('done');
    const c = await stored(check.id);
    expect(c.steps.some(s => s.status === 'WARN' && /^Gathering evidence timed out/.test(s.text))).toBe(true);
    expect((c.evidence as CheckEvidence).degraded).toContain('evidence:timeout');
    expect(c.sigGit).toBe('WARN');
  });
});
