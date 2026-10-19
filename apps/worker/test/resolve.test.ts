/** Stage A: target detection and gap filling with FakeSources, Target re-keying in the test database. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLogger } from '../src/log';
import { CheckRun, type PipelineDeps } from '../src/pipeline/context';
import { findCoin, projectSite, resolveStage, xHandleFromLinks } from '../src/pipeline/resolve';
import { StepLogger } from '../src/pipeline/steps';
import { serveFixture, type FixtureSite } from './fixture-server';
import { dexInfo, fakeSources, xUser, type FakeData } from './fakes';
import { createCheck, heuristicAi, memoryStepDeps, prisma, resetDb, testEnv } from './helpers';

let coinSite: FixtureSite;
let env: ReturnType<typeof testEnv>;
const PEPE = '0x2222222222222222222222222222222222222222';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

beforeAll(async () => {
  coinSite = await serveFixture('coin-site');
  env = testEnv({ SSRF_ALLOW_HOSTS: coinSite.host });
});
afterAll(async () => {
  await coinSite.close();
  await prisma.$disconnect();
});
beforeEach(() => resetDb());

async function resolve(targetRaw: string, data: FakeData) {
  const check = await createCheck(targetRaw);
  const mem = memoryStepDeps();
  const log = memoryLogger();
  const deps: PipelineDeps = { env, prisma, redis: mem.redis, sources: fakeSources(env, data), ai: heuristicAi(), browser: async () => null, log };
  const steps = new StepLogger({ prisma, redis: mem.redis, screenshotDir: env.SCREENSHOT_DIR, log }, check, Date.now());
  const run = new CheckRun(deps, check, steps, Date.now(), Date.now() + 60_000, new AbortController().signal);
  await resolveStage(run, { signal: new AbortController().signal, deadline: Date.now() + 25_000 });
  await steps.flush();
  const target = await prisma.target.findUniqueOrThrow({ where: { id: run.targetId } });
  return { run, texts: steps.rows.map(r => `${r.status}|${r.source ?? ''}|${r.text}`), target };
}

describe('Stage A — resolve', () => {
  it('X post: author, linked site and contract from the post', async () => {
    const post = {
      id: '1849001', text: 'Orbit v2 is live → orbit.xyz\nCA 0x1111111111111111111111111111111111111111 $ORBIT', authorId: '7', authorHandle: 'orbitxyz', authorName: 'Orbit',
      createdAt: null, conversationId: null, urls: ['https://orbit.xyz/'], mentions: [], cashtags: ['ORBIT'], replyToId: null, quotedId: null, author: xUser({ handle: 'orbitxyz' }),
    };
    const coin = '0x1111111111111111111111111111111111111111';
    const { texts, target, run } = await resolve('https://x.com/orbitxyz/status/1849001', {
      posts: { '1849001': post },
      dexTokens: { [coin]: dexInfo({ chain: 'base', address: coin, symbol: 'ORBIT' }) },
    });
    expect(texts).toEqual([
      'info|X|Reading post by @orbitxyz',
      'ok||Found link in post: orbit.xyz',
      'info||Contract found in post: 0x111…1111 on Base',
    ]);
    expect(target).toMatchObject({ key: 'post:1849001', kind: 'POST', name: '@orbitxyz', handle: 'orbitxyz', domain: 'orbit.xyz', ca: coin, chain: 'BASE', ticker: 'ORBIT' });
    expect(run.siteUrl).toBe('https://orbit.xyz/');
  });

  it('X post when X is unavailable: says so and keeps the handle from the URL', async () => {
    const { texts, target } = await resolve('https://x.com/kairolabs/status/1849002', {});
    expect(texts).toEqual(['warn|X|X unavailable, the post could not be read']);
    expect(target).toMatchObject({ key: 'post:1849002', name: '@kairolabs', handle: 'kairolabs' });
  });

  it('X profile: website from the profile', async () => {
    const { texts, target } = await resolve('https://x.com/kairolabs', { users: { kairolabs: xUser({ handle: 'kairolabs', url: 'https://kairo.ai' }) } });
    expect(texts).toEqual(["info|X|Reading @kairolabs's profile", "ok|X|Website from @kairolabs's profile: kairo.ai"]);
    expect(target).toMatchObject({ key: 'x:kairolabs', domain: 'kairo.ai' });
  });

  it('website: contract and X handle from the page HTML (guarded fetch), ignoring other tokens on the page', async () => {
    const { texts, target } = await resolve(coinSite.url, {
      evmChains: { [PEPE]: 'base' },
      dexTokens: { [USDC]: dexInfo({ chain: 'base', address: USDC, symbol: 'USDC', name: 'USD Coin' }), [PEPE]: dexInfo({ chain: 'base', address: PEPE, symbol: 'PROCKET', name: 'Pepe Rocket' }) },
    });
    expect(texts).toEqual(['info||Target is a website: coin-site.test', 'info||Contract found on page: 0x222…2222 on Base']);
    expect(target).toMatchObject({ key: 'site:coin-site.test', kind: 'SITE', name: 'coin-site.test', ca: PEPE, chain: 'BASE', ticker: 'PROCKET', handle: 'peperocket' });
  });

  it('EVM contract: chain detection, then token info → website + X handle', async () => {
    const coin = '0x3333333333333333333333333333333333333333';
    const { texts, target } = await resolve(coin, {
      evmChains: { [coin]: 'arb' },
      dexTokens: { [coin]: dexInfo({ chain: 'arb', address: coin, symbol: 'ZAP', websites: ['https://x.com/zap', 'https://zap.finance'], socials: [{ type: 'twitter', url: 'https://twitter.com/zapfinance' }] }) },
    });
    expect(texts).toEqual(['info|DexScreener|Contract on Arbitrum: 0x333…3333', 'ok|DexScreener|Website from token metadata: zap.finance']);
    expect(target).toMatchObject({ key: `ca:arb:${coin}`, name: '$ZAP', chain: 'ARB', domain: 'zap.finance', handle: 'zapfinance' });
  });

  it('EVM contract found on no chain', async () => {
    const coin = '0x4444444444444444444444444444444444444444';
    const { texts, target } = await resolve(coin, {});
    expect(texts).toEqual(['warn||Contract 0x444…4444 not found on Base, Ethereum, BNB Chain, Arbitrum or Robinhood Chain']);
    expect(target.key).toBe(`ca:evm:${coin}`);
  });
});

describe('resolve helpers', () => {
  it('projectSite skips socials, explorers and launchpads', () => {
    expect(projectSite(['https://x.com/a', 'https://dexscreener.com/base/0x1', 'orbit.xyz'])).toBe('https://orbit.xyz/');
    expect(projectSite(['https://t.me/a'])).toBeNull();
  });
  it('xHandleFromLinks ignores share / intent links', () => {
    expect(xHandleFromLinks(['https://twitter.com/intent/tweet?text=hi', 'https://x.com/share', 'https://x.com/peperocket'])).toBe('peperocket');
  });
  it('findCoin will not guess between unlabelled addresses DexScreener does not know', async () => {
    const env2 = testEnv();
    const deps = { env: env2, sources: fakeSources(env2, { evmChains: { [PEPE]: 'base', [USDC]: 'base' } }) } as unknown as PipelineDeps;
    const run = { sources: deps.sources } as unknown as CheckRun;
    const sig = new AbortController().signal;
    expect(await findCoin(run, `see ${PEPE} and ${USDC}`, sig)).toBeNull();
    expect(await findCoin(run, `pool ${USDC}. Contract address: ${PEPE}`, sig)).toMatchObject({ chain: 'base', ca: PEPE });
  });
  it('findCoin never takes a stablecoin the page mentions for its pool', async () => {
    const env2 = testEnv();
    const sources = fakeSources(env2, { evmChains: { [USDC]: 'base' }, dexTokens: { [USDC]: dexInfo({ chain: 'base', address: USDC, symbol: 'USDC' }) } });
    const run = { sources } as unknown as CheckRun;
    expect(await findCoin(run, `CA: ${USDC}`, new AbortController().signal)).toBeNull();
  });
});
