/** Stage A: target detection and gap filling with FakeSources, Target re-keying in the test database. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvm, createX, reportError, type DexOtherChainToken, type Http, type HttpResponse, type Sources } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { CheckRun, type PipelineDeps } from '../src/pipeline/context';
import { findCoin, finishResolve, projectSite, resolveStage, saveTarget, xHandleFromLinks } from '../src/pipeline/resolve';
import { StepLogger } from '../src/pipeline/steps';
import { serveFixture, serveHandler, type FixtureSite } from './fixture-server';
import { dexInfo, dexOther, fakeSources, xUser, type FakeData, type FakeSources } from './fakes';
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
        for (const c of ['base', 'eth', 'bnb', 'arb', 'rh']) reportError(`evm.getCode ${c}: getaddrinfo ENOTFOUND rpc`);
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
    expect(texts).toEqual(['info|DexScreener|Contract on Arbitrum: 0x333…3333', 'ok|DexScreener|Token metadata: website zap.finance, X @zapfinance']);
    expect(target).toMatchObject({ key: `ca:arb:${coin}`, name: '$ZAP', chain: 'ARB', domain: 'zap.finance', handle: 'zapfinance' });
  });

  it('EVM contract found on no chain (only the chains that were asked are named)', async () => {
    const coin = '0x4444444444444444444444444444444444444444';
    const { texts, target } = await resolve(coin, {});
    expect(texts).toEqual(['warn|On-chain|Contract 0x444…4444 not found on Base, Ethereum, BNB Chain, Arbitrum or Robinhood Chain']);
    expect(target.key).toBe(`ca:evm:${coin}`);
  });

  describe('code only on Robinhood Chain, RPC_ROBINHOOD empty (the real EVM adapter, its public node)', () => {
    const coin = '0x659000000000000000000000000000000000db19';
    /** every chain's public RPC answers eth_getCode: code on the Robinhood host only (or that host failing) */
    const nodes = (rh: 'code' | 'down'): Http => {
      async function request(url: string, req: { body?: unknown } = {}): Promise<HttpResponse> {
        const host = new URL(url).host;
        const { id } = JSON.parse(String(req.body)) as { id: number };
        const res = (status: number, text: string): HttpResponse => ({ status, ok: status < 300, url, finalUrl: url, headers: {}, text, truncated: false, ms: 1 });
        if (host === 'rpc.mainnet.chain.robinhood.com' && rh === 'down') return res(429, 'rate limited');
        return res(200, JSON.stringify({ jsonrpc: '2.0', id, result: host === 'rpc.mainnet.chain.robinhood.com' ? '0x6080604052' : '0x' }));
      }
      return {
        request,
        async json<T>(url: string, req = {}) {
          const r = await request(url, req);
          if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
          return JSON.parse(r.text) as T;
        },
      };
    };
    const realEvm = (rh: 'code' | 'down') => (s: Sources) => {
      s.evm = createEvm(env, nodes(rh), { detectRetryDelayMs: 0 });
    };

    it('resolves to Robinhood Chain, never "Not enough to check"', async () => {
      const { texts, target, run } = await resolve(coin, {}, realEvm('code'));
      expect(texts).toEqual(['info|On-chain|Contract on Robinhood Chain: 0x659…db19', 'info|DexScreener|No trading pair found on DexScreener']);
      expect(target).toMatchObject({ key: `ca:rh:${coin}`, chain: 'RH', ca: coin });
      expect(run.missingCoin).toBeNull();
      expect(run.unconfirmedCoin).toBeNull();
    });

    it('its public node not answering: "Robinhood Chain RPC unavailable", never "not on" it', async () => {
      const { texts, run } = await resolve(coin, {}, realEvm('down'));
      expect(texts[0]).toBe('warn|On-chain|Contract 0x659…db19 not found on Base, Ethereum, BNB Chain or Arbitrum; Robinhood Chain RPC unavailable');
      expect(run.missingCoin).toBeNull();
      expect(run.unconfirmedCoin).toEqual({ address: coin, why: 'the Robinhood Chain RPC unavailable' });
    });
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
    const all = await resolve(coin, {}, down(['base', 'eth', 'bnb', 'arb', 'rh']));
    expect(all.texts).toEqual([
      'warn|On-chain|Couldn\'t reach the Base, Ethereum, BNB Chain, Arbitrum and Robinhood Chain RPCs, so the chain of 0x555…5555 is unknown',
      'warn|DexScreener|DexScreener unavailable, no market data',
    ]);
    const some = await resolve(coin, {}, down(['bnb']));
    expect(some.texts[0]).toBe('warn|On-chain|Contract 0x555…5555 not found on Base, Ethereum, Arbitrum or Robinhood Chain; BNB Chain RPC unavailable');
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

  describe('a contract DexScreener lists only on a chain ApeCheck has no reads for (Sonic)', () => {
    // the production case: an ESCO-ecosystem token on Sonic, tagged as "CA: 0x17c6…"
    const SONIC = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
    const ON_SONIC = "warn|DexScreener|Contract on Sonic: 0x17c…d1fc (on-chain reads aren't supported there yet, so the coin isn't checked)";
    const listed = (p: Partial<DexOtherChainToken> = {}): FakeData => ({ dexOther: { [SONIC]: dexOther({ address: SONIC, ...p }) } });
    const withSite = listed({
      websites: ['https://dexscreener.com/sonic/0xpair', 'https://esco.example'],
      socials: [{ type: 'twitter', url: 'https://x.com/escofinance' }, { type: 'telegram', url: 'https://t.me/escofi' }],
    });

    it('names the chain, scores no coin, and checks the website from its token info instead (the Target becomes the site)', async () => {
      const { texts, target, run } = await resolve(SONIC, withSite);
      expect(texts).toEqual([ON_SONIC, 'ok|DexScreener|Token metadata: website esco.example, X @escofinance', "info||Checking the project's website instead: esco.example"]);
      expect(run).toMatchObject({
        kind: 'site', chain: null, ca: null, market: null, siteUrl: 'https://esco.example/', handle: 'escofinance',
        otherChain: { address: SONIC, chain: 'Sonic', site: 'esco.example' },
      });
      expect(run.hasCoin()).toBe(false);
      expect(run.links).toMatchObject({ site: 'https://esco.example/', x: 'https://x.com/escofinance', telegram: 'https://t.me/escofi' });
      // the Sonic token's ticker is not the site's: a site Target's ticker is that of its own coin (see below)
      expect(run.ticker).toBeNull();
      expect(target).toMatchObject({ key: 'site:esco.example', kind: 'SITE', name: 'esco.example', domain: 'esco.example', handle: 'escofinance', ticker: null, chain: null });
      expect(await prisma.target.count({ where: { key: `ca:evm:${SONIC}` } })).toBe(0);
      // no on-chain reads anywhere for it: never the coin facts, never "not found on the chains searched"
      expect((run.sources as FakeSources).calls.filter(c => c.startsWith('coinFacts'))).toEqual([]);
      expect(texts.some(t => /not found/i.test(t))).toBe(false);
    });

    it("a site that already has a Target keeps its own coin and ticker: the Sonic contract and its ticker aren't written over them", async () => {
      const BASE_COIN = '0x7777777777777777777777777777777777777777';
      const owner = await prisma.target.create({
        data: { key: 'site:esco.example', kind: 'SITE', domain: 'esco.example', chain: 'BASE', ca: BASE_COIN, ticker: 'BASEY', name: 'esco.example', checkCount: 1 },
      });
      const { run, target } = await resolve(SONIC, withSite);
      expect(run.targetId).toBe(owner.id);
      expect(target).toMatchObject({ id: owner.id, chain: 'BASE', ca: BASE_COIN, ticker: 'BASEY', checkCount: 2 });
    });

    it('without a website in its token info: names the chain and claims nothing else (no site, no coin, no "not found")', async () => {
      const { texts, target, run } = await resolve(SONIC, listed());
      expect(texts).toEqual([ON_SONIC, 'info|DexScreener|No website in the token metadata']);
      expect(run).toMatchObject({ kind: 'coin', chain: null, market: null, siteUrl: null, handle: null, coinAnnounced: true, otherChain: { address: SONIC, chain: 'Sonic', site: null } });
      expect(run.hasCoin()).toBe(false);
      // the contract's own Target: its ticker is this token's
      expect(target).toMatchObject({ key: `ca:evm:${SONIC}`, kind: 'COIN', chain: null, domain: null, ticker: 'ESCO' });
    });

    // a treasury multisig with code on Ethereum next to the Sonic contract on the project's site: it is not "the only
    // address" there just because the Sonic one was named already, so it is never scored as the project's coin
    const TREASURY = '0x9999999999999999999999999999999999999999';
    for (const [what, sonicLine] of [
      ['unlabelled', `Trade ESCO on Sonic ${SONIC}`],
      ['labelled "CA:"', `CA: ${SONIC}`],
    ] as const) {
      it(`the site's HTML (scanSiteHtml): the Sonic contract ${what} next to a treasury multisig is not read as a coin on Ethereum`, async () => {
        const site = await serveHandler('esco-site', (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><title>Esco</title><h1>Esco on Sonic</h1><p>${sonicLine}</p><p>Treasury multisig: ${TREASURY}</p>`);
        });
        try {
          const { texts, target, run } = await resolve(SONIC, {
            ...listed({ websites: [site.url] }),
            allowHosts: [site.host],
            evmChains: { [TREASURY]: 'eth' },
          });
          expect(texts).toEqual([ON_SONIC, `ok|DexScreener|Token metadata: website ${site.host.split(':')[0]}`, `info||Checking the project's website instead: ${site.host.split(':')[0]}`]);
          expect(run).toMatchObject({ kind: 'site', chain: null, ca: null, otherChain: { address: SONIC, site: site.host.split(':')[0] } });
          expect(run.hasCoin()).toBe(false);
          expect(target).toMatchObject({ kind: 'SITE', chain: null });
          const calls = (run.sources as FakeSources).calls;
          // the Sonic contract is not looked up again, and the multisig is never taken for the coin
          expect(calls.filter(c => c.includes(SONIC))).toEqual([`evm.detectChain ${SONIC}`, `dex.token ${SONIC}`, `dex.otherChain ${SONIC}`]);
          expect(calls).not.toContain(`evm.detectChain ${TREASURY}`);
        } finally {
          await site.close();
        }
      });
    }

    it('an X account but no website: the account is named, nothing else is taken', async () => {
      const { texts, run } = await resolve(SONIC, listed({ socials: [{ type: 'twitter', url: 'https://x.com/escofinance' }] }));
      expect(texts).toEqual([ON_SONIC, 'ok|DexScreener|Token metadata: X @escofinance', 'info|DexScreener|No website in the token metadata']);
      expect(run).toMatchObject({ kind: 'coin', siteUrl: null, handle: 'escofinance' });
    });

    it('an RPC that did not answer is said, next to the chain DexScreener lists it on', async () => {
      const { texts } = await resolve(SONIC, withSite, s => {
        s.evm.detectChain = async () => {
          reportError('evm.getCode bnb: HTTP 429 from bsc-dataseed.bnbchain.org');
          return null;
        };
      });
      expect(texts.slice(0, 2)).toEqual([ON_SONIC, 'warn|On-chain|BNB Chain RPC unavailable; DexScreener lists the contract on Sonic']);
    });

    it('DexScreener not answering for other chains: "not found" on the chains asked, and DexScreener named as unavailable', async () => {
      const { texts } = await resolve(SONIC, withSite, s => {
        s.dex.otherChain = async () => {
          reportError('dexscreener.otherChain: HTTP 503 from api.dexscreener.com');
          return null;
        };
      });
      expect(texts).toEqual(['warn|On-chain|Contract 0x17c…d1fc not found on Base, Ethereum, BNB Chain, Arbitrum or Robinhood Chain', 'warn|DexScreener|DexScreener unavailable, no market data']);
    });

    it('in an X post without a link: named in the post, and its website is the one checked', async () => {
      const post = {
        id: '1849010', text: `Dex paid.\nCA: ${SONIC}`, authorId: '7', authorHandle: 'escofinance', authorName: 'Esco',
        createdAt: null, conversationId: null, urls: [], mentions: [], cashtags: [], replyToId: null, quotedId: null, author: null,
      };
      const { texts, target, run } = await resolve('https://x.com/escofinance/status/1849010', { ...withSite, posts: { '1849010': post } });
      expect(texts).toEqual([
        'info|X|Reading post by @escofinance',
        "warn|DexScreener|Contract found in post: 0x17c…d1fc on Sonic (on-chain reads aren't supported there yet, so the coin isn't checked)",
        'ok|DexScreener|Token metadata: website esco.example',
      ]);
      expect(run).toMatchObject({ kind: 'post', chain: null, siteUrl: 'https://esco.example/', coinAnnounced: true, otherChain: { address: SONIC, chain: 'Sonic', site: null } });
      expect(target).toMatchObject({ key: 'post:1849010', kind: 'POST', domain: 'esco.example', chain: null, ca: null });
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
  it("findCoin: a labelled address on none of ApeCheck's chains but listed on Sonic comes back as that, and is never looked up twice", async () => {
    const SONIC = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
    const sources = fakeSources(testEnv(), { dexOther: { [SONIC]: dexOther({ address: SONIC }) } });
    const run = { sources, otherChain: null } as unknown as CheckRun;
    const sig = new AbortController().signal;
    expect(await findCoin(run, `Dex paid. CA: ${SONIC}`, sig)).toMatchObject({ ca: SONIC, other: { dexChain: 'sonic', chainName: 'Sonic' } });
    run.otherChain = { address: SONIC, chain: 'Sonic', site: null };
    sources.calls.length = 0;
    expect(await findCoin(run, `Dex paid. CA: ${SONIC.toUpperCase().replace('0X', '0x')}`, sig)).toBeNull();
    expect(sources.calls).toEqual([]);
  });
  it('findCoin: the contract already named on another chain still counts, so a second unlabelled address is never "the only one"', async () => {
    const SONIC = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
    const TREASURY = '0x9999999999999999999999999999999999999999';
    const sources = fakeSources(testEnv(), { dexOther: { [SONIC]: dexOther({ address: SONIC }) }, evmChains: { [TREASURY]: 'eth' } });
    const run = { sources, otherChain: { address: SONIC, chain: 'Sonic', site: null }, unconfirmedCoin: null } as unknown as CheckRun;
    const sig = new AbortController().signal;
    expect(await findCoin(run, `ESCO ${SONIC}\nTreasury ${TREASURY}`, sig)).toBeNull();
    expect(await findCoin(run, `Token address: ${SONIC}\nTreasury ${TREASURY}`, sig)).toBeNull();
    // only the treasury is looked up on DexScreener; nothing is taken as the coin, so no chain is asked for it
    expect(sources.calls).toEqual([`dex.token ${TREASURY}`, `dex.token ${TREASURY}`]);
    // alone, a labelled treasury would still be the page's coin (the rule for every page)
    expect(await findCoin(run, `Contract: ${TREASURY}`, sig)).toMatchObject({ chain: 'eth', ca: TREASURY });
  });
  it('findCoin never takes a stablecoin the page mentions for its pool', async () => {
    const env2 = testEnv();
    const sources = fakeSources(env2, { evmChains: { [USDC]: 'base' }, dexTokens: { [USDC]: dexInfo({ chain: 'base', address: USDC, symbol: 'USDC' }) } });
    const run = { sources } as unknown as CheckRun;
    expect(await findCoin(run, `CA: ${USDC}`, new AbortController().signal)).toBeNull();
  });
});
