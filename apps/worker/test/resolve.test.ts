/** Stage A: target detection and gap filling with FakeSources, Target re-keying in the test database. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createX, reportError, type Http, type Sources } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { CheckRun, type PipelineDeps } from '../src/pipeline/context';
import { findCoin, finishResolve, projectSite, resolveStage, saveTarget, xHandleFromLinks } from '../src/pipeline/resolve';
import { StepLogger } from '../src/pipeline/steps';
import { serveFixture, type FixtureSite } from './fixture-server';
import { dexInfo, fakeSources, xUser, type FakeData, type FakeSources } from './fakes';
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

async function resolve(targetRaw: string, data: FakeData, tweak?: (s: Sources) => void) {
  const check = await createCheck(targetRaw);
  const mem = memoryStepDeps();
  const log = memoryLogger();
  const sources = fakeSources(env, data);
  tweak?.(sources);
  const deps: PipelineDeps = { env, prisma, redis: mem.redis, sources, ai: heuristicAi(), browser: async () => null, log };
  const steps = new StepLogger({ prisma, redis: mem.redis, screenshotDir: env.SCREENSHOT_DIR, log }, check, Date.now());
  const run = new CheckRun(deps, check, steps, Date.now(), Date.now() + 60_000, new AbortController().signal);
  await resolveStage(run, { signal: new AbortController().signal, deadline: Date.now() + 25_000 });
  // runCheck saves the Target once Stage A is over
  finishResolve(run);
  await saveTarget(run);
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

  it("X post the free embed endpoints can't read: says so and keeps the handle from the URL", async () => {
    const { texts, target } = await resolve('https://x.com/kairolabs/status/1849002', {});
    expect(texts).toEqual(["warn|X|Couldn't read the post on X"]);
    expect(target).toMatchObject({ key: 'post:1849002', name: '@kairolabs', handle: 'kairolabs' });
  });

  it('X post with every X key set: read through the free syndication endpoint, never the paid X API', async () => {
    const calls: string[] = [];
    const syndication = {
      __typename: 'Tweet',
      id_str: '1849003',
      text: 'Orbit v2 is live https://t.co/0rb1t',
      created_at: '2026-10-18T14:02:11.000Z',
      entities: { urls: [{ url: 'https://t.co/0rb1t', expanded_url: 'https://orbit.xyz/app', display_url: 'orbit.xyz/app' }], user_mentions: [], symbols: [] },
      user: { id_str: '7', screen_name: 'orbitxyz', name: 'Orbit' },
    };
    const http: Http = {
      async request(url) {
        calls.push(url);
        const host = new URL(url).host;
        const ok = host === 'cdn.syndication.twimg.com';
        return { status: ok ? 200 : 599, ok, url, finalUrl: url, headers: {}, text: ok ? JSON.stringify(syndication) : '', truncated: false, ms: 1 };
      },
      async json() {
        throw new Error('not used');
      },
    };
    const keys = testEnv({ X_BEARER_TOKEN: 'paid-bearer', X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'u' });
    const { texts, run } = await resolve('https://x.com/orbitxyz/status/1849003', {}, s => {
      s.x = createX(keys, http);
    });
    expect(texts).toEqual(['info|X|Reading post by @orbitxyz', 'ok||Found link in post: orbit.xyz']);
    expect(run.post?.urls).toEqual(['https://orbit.xyz/app']);
    expect(calls.map(u => new URL(u).host)).toEqual(['cdn.syndication.twimg.com']);
    expect(calls.some(u => new URL(u).host === 'api.x.com')).toBe(false);
  });

  it('X post without a site: no fallback to the author profile (accounts are never read)', async () => {
    const post = {
      id: '1849004', text: 'gm', authorId: '7', authorHandle: 'orbitxyz', authorName: 'Orbit',
      createdAt: null, conversationId: null, urls: [], mentions: [], cashtags: [], replyToId: null, quotedId: null, author: null,
    };
    const { texts, run } = await resolve('https://x.com/orbitxyz/status/1849004', { posts: { '1849004': post }, users: { orbitxyz: xUser({ handle: 'orbitxyz', url: 'https://orbit.xyz' }) } });
    expect(texts).toEqual(['info|X|Reading post by @orbitxyz']);
    expect(run.siteUrl).toBeNull();
    expect((run.sources as FakeSources).calls.filter(c => c.startsWith('x.getUser'))).toEqual([]);
  });

  it('X profile: only the handle (profiles are not read)', async () => {
    const { texts, target, run } = await resolve('https://x.com/kairolabs', { users: { kairolabs: xUser({ handle: 'kairolabs', url: 'https://kairo.ai' }) } });
    expect(texts).toEqual(["info|X|Target is an X account: @kairolabs (profiles aren't read; paste a post or the website to check more)"]);
    expect(target).toMatchObject({ key: 'x:kairolabs', handle: 'kairolabs', domain: null });
    expect((run.sources as FakeSources).calls.filter(c => c.startsWith('x.'))).toEqual([]);
  });

  it('website: contract and X handle from the page HTML (guarded fetch), ignoring other tokens on the page', async () => {
    const { texts, target } = await resolve(coinSite.url, {
      evmChains: { [PEPE]: 'base' },
      dexTokens: { [USDC]: dexInfo({ chain: 'base', address: USDC, symbol: 'USDC', name: 'USD Coin' }), [PEPE]: dexInfo({ chain: 'base', address: PEPE, symbol: 'PROCKET', name: 'Pepe Rocket' }) },
    });
    expect(texts).toEqual(['info||Target is a website: coin-site.test', 'info||Contract found on page: 0x222…2222 on Base']);
    expect(target).toMatchObject({ key: 'site:coin-site.test', kind: 'SITE', name: 'coin-site.test', ca: PEPE, chain: 'BASE', ticker: 'PROCKET', handle: 'peperocket' });
  });

  it('website: a contract on the page that DexScreener and the RPCs could not vet is "unconfirmed", not "not found"', async () => {
    const { run, target } = await resolve(coinSite.url, {}, s => {
      s.dex.token = async () => {
        reportError('dexscreener.token: getaddrinfo ENOTFOUND api.dexscreener.com');
        return null;
      };
      s.evm.detectChain = async () => {
        for (const c of ['base', 'eth', 'bnb', 'arb']) reportError(`evm.getCode ${c}: getaddrinfo ENOTFOUND rpc`);
        return null;
      };
    });
    expect(run.hasCoin()).toBe(false);
    expect(run.unconfirmedCoin).toEqual({ address: PEPE, why: 'DexScreener and the chain RPCs unavailable' });
    expect(target.ca).toBeNull();
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

  it('EVM contract found on no chain (only the chains that were asked are named)', async () => {
    const coin = '0x4444444444444444444444444444444444444444';
    const { texts, target } = await resolve(coin, {});
    expect(texts).toEqual(['warn|On-chain|Contract 0x444…4444 not found on Base, Ethereum, BNB Chain or Arbitrum']);
    expect(target.key).toBe(`ca:evm:${coin}`);
  });

  it('never says "not found" for chains whose RPC could not answer', async () => {
    const coin = '0x5555555555555555555555555555555555555555';
    const down = (chains: string[]) => (s: Sources) => {
      s.evm.detectChain = async () => {
        for (const c of chains) reportError(`evm.getCode ${c}: getaddrinfo ENOTFOUND rpc.${c}`);
        return null;
      };
      s.dex.token = async () => {
        reportError('dexscreener.token: getaddrinfo ENOTFOUND api.dexscreener.com');
        return null;
      };
    };
    const all = await resolve(coin, {}, down(['base', 'eth', 'bnb', 'arb']));
    expect(all.texts).toEqual([
      'warn|On-chain|Couldn\'t reach the Base, Ethereum, BNB Chain and Arbitrum RPCs, so the chain of 0x555…5555 is unknown',
      'warn|DexScreener|DexScreener unavailable, no market data',
    ]);
    const some = await resolve(coin, {}, down(['bnb']));
    expect(some.texts[0]).toBe('warn|On-chain|Contract 0x555…5555 not found on Base, Ethereum or Arbitrum; BNB Chain RPC unavailable');
  });

  describe('an earlier chain\'s RPC did not answer but a later chain has the code', () => {
    const coin = '0x6666666666666666666666666666666666666666';
    // Base rate-limited for the whole detection (the adapter already retried it), same address has code on Ethereum
    const baseDown = (s: Sources) => {
      s.evm.detectChain = async () => {
        reportError('evm.getCode base: HTTP 429 from mainnet.base.org');
        return 'eth';
      };
    };

    it('DexScreener\'s pair on the unanswered chain wins', async () => {
      const { texts, target, run } = await resolve(coin, { dexTokens: { [coin]: dexInfo({ chain: 'base', address: coin, symbol: 'SAME' }) } }, baseDown);
      expect(texts[0]).toBe('info|DexScreener|Contract on Base: 0x666…6666');
      expect(texts.some(t => t.includes('RPC unavailable'))).toBe(false);
      expect(target).toMatchObject({ key: `ca:base:${coin}`, chain: 'BASE', ticker: 'SAME' });
      expect(run.market?.chain).toBe('base');
    });

    it('no pair anywhere: stays on the later chain and says the earlier RPC went unanswered', async () => {
      const { texts, target } = await resolve(coin, {}, baseDown);
      expect(texts).toEqual([
        'info|On-chain|Contract on Ethereum: 0x666…6666',
        'warn|On-chain|Base RPC unavailable; contract found on Ethereum',
        'info|DexScreener|No trading pair found on DexScreener',
      ]);
      expect(target).toMatchObject({ key: `ca:eth:${coin}`, chain: 'ETH' });
    });

    it('a pair on a chain after the hit is not used; the hit chain is asked for its own pair', async () => {
      const { texts, target, run } = await resolve(coin, { dexTokens: { [coin]: dexInfo({ chain: 'arb', address: coin }) } }, baseDown);
      expect(texts[0]).toBe('info|On-chain|Contract on Ethereum: 0x666…6666');
      expect(texts[1]).toBe('warn|On-chain|Base RPC unavailable; contract found on Ethereum');
      expect(target).toMatchObject({ chain: 'ETH' });
      expect(run.market).toBeNull();
    });
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
