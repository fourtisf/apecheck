/**
 * `pnpm diagnose` (src/doctor): status classification, redaction, per-probe timeouts, the exit code and the table,
 * and the probes' verdicts on recorded answers (fake Http and adapters; nothing leaves the machine).
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { getEnv, type Env } from '@apecheck/core';
import { HttpError, reportError, solanaRpcUrl, startGuardProxy, type Http, type HttpRequest, type HttpResponse } from '@apecheck/sources';
import { AiOutputError } from '../src/ai/anthropic';
import { createAi } from '../src/ai/index';
import { aiErrorText, probeAi } from '../src/doctor/ai';
import { probeDexScreener, probeGitHub, probeXBot, probeXRead } from '../src/doctor/apis';
import { probeEtherscan, probeEvm, probeRobinhood, probeSolana } from '../src/doctor/chains';
import { buildProbes, headerLines } from '../src/doctor/index';
import { bullWorkers, connectThrough, probeBrowserGuard, probeBrowserHost, probePostgres, probeRedis } from '../src/doctor/infra';
import { Redactor, dbLabel, hostOf, wsLabel } from '../src/doctor/redact';
import { formatReport, formatTable, summaryLine } from '../src/doctor/report';
import { classify, errorText, exitCode, networkRemedy, outcome, runProbe, runProbes, type ProbeResult } from '../src/doctor/result';

const prodEnv = (over: Record<string, string> = {}): Env => getEnv({ NODE_ENV: 'production', ...over });

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** Http that answers from `handler` and records every request (json() throws HttpError on non-2xx, as createHttp does). */
function fakeHttp(handler: (url: string, req: HttpRequest) => Answer): Http & { calls: { url: string; req: HttpRequest }[] } {
  const calls: { url: string; req: HttpRequest }[] = [];
  async function request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    calls.push({ url, req });
    const a = handler(url, req);
    if (a instanceof Error) throw a;
    const status = a.status ?? 200;
    const text = typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? null);
    return { status, ok: status >= 200 && status < 300, url, finalUrl: url, headers: a.headers ?? {}, text, truncated: false, ms: 5 };
  }
  return {
    calls,
    request,
    async json<T>(url: string, req: HttpRequest = {}): Promise<T> {
      const res = await request(url, req);
      if (!res.ok) throw new HttpError(res.status, res.finalUrl, res.text, res.headers);
      return JSON.parse(res.text) as T;
    },
  };
}

/** a JSON-RPC node answering each method from `results` */
const rpcNode = (results: Record<string, unknown>) => (_url: string, req: HttpRequest): Answer => {
  const { id, method } = JSON.parse(String(req.body)) as { id: number; method: string };
  return { body: { jsonrpc: '2.0', id, result: results[method] } };
};

const usdc = { name: 'USD Coin', symbol: 'USDC', decimals: 6, totalSupply: '1', owner: '0x1', ownerRenounced: false, hasMintFunction: false };

describe('classify / outcome', () => {
  it('FAIL whenever a request answered wrong, keyed or keyless', () => {
    expect(classify({ ok: false, configured: true, importance: 'optional' })).toBe('FAIL');
    expect(classify({ ok: false, configured: false, importance: 'recommended' })).toBe('FAIL');
  });
  it('nothing sent: FAIL for required infrastructure, WARN for a recommended key, SKIP for an optional one', () => {
    expect(classify({ ok: null, configured: false, importance: 'required' })).toBe('FAIL');
    expect(classify({ ok: null, configured: false, importance: 'recommended' })).toBe('WARN');
    expect(classify({ ok: null, configured: false, importance: 'optional' })).toBe('SKIP');
  });
  it('a keyless fallback that answered is WARN; a keyed answer is PASS unless degraded', () => {
    expect(classify({ ok: true, configured: false, importance: 'recommended' })).toBe('WARN');
    expect(classify({ ok: true, configured: true, importance: 'recommended' })).toBe('PASS');
    expect(classify({ ok: true, configured: true, importance: 'recommended', degraded: true })).toBe('WARN');
  });
  it('drops the remedy on PASS only', () => {
    expect(outcome({ ok: true, configured: true, importance: 'optional' }, 'fine', 'set X')).toEqual({ status: 'PASS', detail: 'fine' });
    expect(outcome({ ok: true, configured: false, importance: 'optional' }, 'keyless', 'set X')).toEqual({ status: 'WARN', detail: 'keyless', remedy: 'set X' });
  });
  it('keeps the line that says what happened', () => {
    const prisma = new Error("\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach database server at `localhost:5999`\n\nPlease make sure ...");
    expect(errorText(prisma)).toBe("Can't reach database server at `localhost:5999`");
    expect(errorText(new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/\nCall log:\n  - navigating'))).toBe(
      'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/',
    );
    expect(errorText(Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND x.io') }))).toBe('fetch failed (getaddrinfo ENOTFOUND x.io)');
  });
  it('recognises a network failure and names the host', () => {
    expect(networkRemedy('evm.getCode base: getaddrinfo ENOTFOUND mainnet.base.org', 'mainnet.base.org')).toMatch(/no answer from mainnet\.base\.org/);
    expect(networkRemedy('api.x.com: timeout after 10000ms', 'api.x.com')).toMatch(/curl -sSI https:\/\/api\.x\.com\//);
    expect(networkRemedy('HTTP 429 from api.dexscreener.com', 'api.dexscreener.com')).toBeNull();
  });
});

describe('runProbe', () => {
  it('a probe that never answers is a FAIL after its own timeout, with its remedy, and its signal is aborted', async () => {
    let signal: AbortSignal | null = null;
    const r = await runProbe({
      name: 'slow',
      timeoutMs: 50,
      remedy: 'check the network',
      run: s => {
        signal = s;
        return new Promise(() => undefined);
      },
    });
    expect(r).toMatchObject({ name: 'slow', status: 'FAIL', remedy: 'check the network' });
    expect(r.detail).toMatch(/timed out after 0\.1 s/);
    expect(r.ms).toBeGreaterThanOrEqual(45);
    expect(signal!.aborted).toBe(true);
  });
  it('a throwing probe (sync or async) is a FAIL row, never an exception', async () => {
    const asyncThrow = await runProbe({ name: 'a', run: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); } });
    expect(asyncThrow).toMatchObject({ status: 'FAIL', detail: 'connect ECONNREFUSED 127.0.0.1:5432' });
    const syncThrow = await runProbe({ name: 'b', run: () => { throw new TypeError('bad'); } });
    expect(syncThrow).toMatchObject({ status: 'FAIL', detail: 'bad' });
  });
  it('a rejection after the timeout is not an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const r = await runProbe({ name: 'late', timeoutMs: 20, run: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 60)) });
      expect(r.status).toBe('FAIL');
      await new Promise(res => setTimeout(res, 100));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
  it('runs every probe at once and keeps their order', async () => {
    const wait = (ms: number, detail: string) => () => new Promise<{ status: 'PASS'; detail: string }>(res => setTimeout(() => res({ status: 'PASS', detail }), ms));
    const started = Date.now();
    const results = await runProbes([
      { name: 'one', run: wait(120, 'first') },
      { name: 'two', run: wait(10, 'second') },
      { name: 'three', timeoutMs: 30, run: () => new Promise(() => undefined) },
    ]);
    expect(Date.now() - started).toBeLessThan(220);
    expect(results.map(r => [r.name, r.status])).toEqual([['one', 'PASS'], ['two', 'PASS'], ['three', 'FAIL']]);
  });
});

describe('exitCode', () => {
  it('is 1 when any row FAILs, else 0 (WARN and SKIP never fail the command)', () => {
    expect(exitCode([{ status: 'PASS' }, { status: 'FAIL' }, { status: 'WARN' }])).toBe(1);
    expect(exitCode([{ status: 'PASS' }, { status: 'WARN' }, { status: 'SKIP' }])).toBe(0);
    expect(exitCode([])).toBe(0);
  });
});

describe('redaction', () => {
  const secret = 'a'.repeat(8) + 'b'.repeat(56);
  const env = prodEnv({
    ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETSECRET',
    X_BEARER_TOKEN: 'AAAA%2Fbearer+token/with=chars',
    HELIUS_API_KEY: 'helius-key-123',
    GITHUB_TOKEN: 'github_pat_SECRET123',
    RPC_ETH: 'https://eth-mainnet.g.alchemy.com/v2/ALCHEMYKEY99',
    RPC_SOLANA: 'https://rpc.example.com/?token=QUERYTOKEN77',
    DATABASE_URL: 'postgresql://apecheck:S3cr%40tPassw0rd@db.internal:5432/apecheck',
    REDIS_URL: 'redis://:redisPass123@localhost:6379/0',
    BROWSER_WS_ENDPOINT: `ws://127.0.0.1:9223/${secret}`,
  });
  const r = new Redactor(env);

  it('removes every key, token, password and the browser path, also URL-encoded', () => {
    const text = [
      'key sk-ant-api03-SECRETSECRET',
      `bearer ${encodeURIComponent('AAAA%2Fbearer+token/with=chars')}`,
      `helius ${solanaRpcUrl({ RPC_SOLANA: undefined, HELIUS_API_KEY: 'helius-key-123' })}`,
      'gh github_pat_SECRET123',
      'rpc https://eth-mainnet.g.alchemy.com/v2/ALCHEMYKEY99 and /v2/ALCHEMYKEY99',
      'sol ?token=QUERYTOKEN77',
      'db S3cr@tPassw0rd S3cr%40tPassw0rd',
      'redis redisPass123',
      `ws ws://127.0.0.1:9223/${secret} bare ${secret}`,
    ].join('\n');
    const out = r.text(text);
    for (const s of ['SECRETSECRET', 'bearer+token', 'helius-key-123', 'github_pat_', 'ALCHEMYKEY99', 'QUERYTOKEN77', 'S3cr', 'redisPass123', secret]) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain('ws://127.0.0.1:9223/<BROWSER_WS_PATH>');
  });
  it('hides key-looking query parameters, URL passwords and Bearer tokens from any source', () => {
    const out = new Redactor({}).text('GET https://x.io/a?api-key=abc123&x=1 redis://u:hunter22@h:1 Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
    expect(out).toBe('GET https://x.io/a?api-key=<redacted>&x=1 redis://u:<redacted>@h:1 Authorization: Bearer <redacted>');
    // the words themselves are not secrets
    expect(new Redactor({}).text('Keys and tokens > Bearer Token')).toBe('Keys and tokens > Bearer Token');
  });
  it('keeps a dev placeholder password that is also the user name (it would blank the app name everywhere)', () => {
    const dev = new Redactor(prodEnv({ DATABASE_URL: 'postgresql://apecheck:apecheck@localhost:5432/apecheck' }));
    expect(dev.text('/srv/apecheck/app/.env')).toBe('/srv/apecheck/app/.env');
  });
  it('a secret broken by a line break or NUL (bad quoting in .env) is hidden piece by piece', () => {
    const key = `sk-ant-api03-${'K'.repeat(60)}\n${'T'.repeat(40)}`;
    const out = new Redactor(prodEnv({ ANTHROPIC_API_KEY: key })).text(`first line ${key.split('\n')[0]}\nsecond ${'T'.repeat(40)}`);
    expect(out).toBe('first line <redacted>\nsecond <redacted>');
  });
  it('labels show hosts only', () => {
    expect(hostOf('https://eth-mainnet.g.alchemy.com/v2/KEY')).toBe('eth-mainnet.g.alchemy.com');
    expect(hostOf('not a url')).toBe('(invalid URL)');
    expect(dbLabel('postgresql://u:p@db:5433/apecheck?schema=x', 5432)).toBe('db:5433/apecheck');
    expect(dbLabel('redis://:p@localhost', 6379)).toBe('localhost:6379');
    expect(wsLabel(`ws://127.0.0.1:9223/${secret}`)).toBe('ws://127.0.0.1:9223/<BROWSER_WS_PATH>');
  });
});

describe('report', () => {
  const results: ProbeResult[] = [
    { name: 'Postgres', status: 'PASS', detail: 'localhost:5432/apecheck', ms: 12, remedy: 'never shown' },
    { name: 'RPC Base', status: 'WARN', detail: 'mainnet.base.org (public fallback)', ms: 1840, remedy: 'set RPC_BASE' },
    { name: 'X reads (Bearer)', status: 'FAIL', detail: 'HTTP 401 for token SECRETTOKEN1', ms: 300, remedy: 'regenerate SECRETTOKEN1' },
  ];
  it('aligns the columns, puts the fix under the detail and redacts both', () => {
    const lines = formatTable(results, s => s.replace(/SECRETTOKEN1/g, '<redacted>'));
    const detailCol = lines[0].indexOf('DETAIL');
    expect(lines[1].slice(detailCol)).toBe('localhost:5432/apecheck');
    expect(lines[2].slice(detailCol)).toBe('mainnet.base.org (public fallback)');
    expect(lines[3]).toBe(`${' '.repeat(detailCol)}fix: set RPC_BASE`);
    expect(lines.join('\n')).not.toContain('never shown');
    expect(lines.join('\n')).not.toContain('SECRETTOKEN1');
    expect(lines[2]).toMatch(/^WARN {4}RPC Base {10} {3}1\.8s {2}/);
  });
  it('ends with the counts and the exit code', () => {
    expect(summaryLine(results)).toBe('Summary: 1 PASS, 1 WARN, 1 FAIL, 0 SKIP. Exit code 1: fix the FAIL rows first, then the WARN rows.');
    expect(summaryLine(results.slice(0, 2))).toBe('Summary: 1 PASS, 1 WARN, 0 FAIL, 0 SKIP. Exit code 0: it works, but read the WARN rows.');
    const report = formatReport(['header SECRETTOKEN1'], results, s => s.replace(/SECRETTOKEN1/g, '<redacted>'));
    expect(report.split('\n')[0]).toBe('header <redacted>');
  });
});

describe('EVM probes', () => {
  it('a keyless public RPC that answers is WARN with its block, the decoded token and which variable to set', async () => {
    const http = fakeHttp(rpcNode({ eth_chainId: '0x2105', eth_blockNumber: '0x165ec15' }));
    const evm = { tokenBasics: vi.fn(async () => usdc) };
    const r = await probeEvm('base', { env: prodEnv(), http, evm });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('mainnet.base.org (public fallback, RPC_BASE empty), chainId 0x2105, block 23,456,789, USDC symbol=USDC decimals=6');
    expect(r.remedy).toMatch(/^set ALCHEMY_API_KEY .*, or set RPC_BASE /);
    expect(evm.tokenBasics).toHaveBeenCalledWith('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    // only read methods, to the fallback host
    expect(http.calls.map(c => [new URL(c.url).host, JSON.parse(String(c.req.body)).method]).sort()).toEqual([
      ['mainnet.base.org', 'eth_blockNumber'],
      ['mainnet.base.org', 'eth_chainId'],
    ]);
  });
  it('PASS with its own RPC, host only in the detail', async () => {
    const env = prodEnv({ RPC_ETH: 'https://eth-mainnet.g.alchemy.com/v2/KEY123' });
    const r = await probeEvm('eth', { env, http: fakeHttp(rpcNode({ eth_chainId: '0x1', eth_blockNumber: '0x10' })), evm: { tokenBasics: async () => usdc } });
    expect(r.status).toBe('PASS');
    expect(r.detail).toMatch(/^eth-mainnet\.g\.alchemy\.com \(RPC_ETH\), chainId 0x1, block 16/);
    expect(r.detail).not.toContain('KEY123');
  });
  it('PASS through ALCHEMY_API_KEY alone, named as the source', async () => {
    const env = prodEnv({ ALCHEMY_API_KEY: 'alcKEY999' });
    const r = await probeEvm('base', { env, http: fakeHttp(rpcNode({ eth_chainId: '0x2105', eth_blockNumber: '0x10' })), evm: { tokenBasics: async () => usdc } });
    expect(r.status).toBe('PASS');
    expect(r.detail).toMatch(/^base-mainnet\.g\.alchemy\.com \(ALCHEMY_API_KEY\), chainId 0x2105/);
  });
  it('an RPC on the wrong network is a FAIL naming the network it is on', async () => {
    const env = prodEnv({ RPC_BASE: 'https://eth.example/v2/KEY' });
    const evm = { tokenBasics: vi.fn(async () => usdc) };
    const r = await probeEvm('base', { env, http: fakeHttp(rpcNode({ eth_chainId: '0x1', eth_blockNumber: '0x10' })), evm });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('wrong network, chainId 0x1 (Ethereum), expected 0x2105 (Base)');
    expect(r.remedy).toMatch(/RPC_BASE must give a Base mainnet endpoint/);
    expect(evm.tokenBasics).not.toHaveBeenCalled();
  });
  it('a token the node would not read (eth_call refused) is a FAIL with the fix for that endpoint', async () => {
    const evm = { tokenBasics: async () => ({ ...usdc, name: null, symbol: null, decimals: null }) };
    const http = fakeHttp(rpcNode({ eth_chainId: '0x2105', eth_blockNumber: '0x1' }));
    const keyless = await probeEvm('base', { env: prodEnv(), http, evm });
    expect(keyless).toMatchObject({ status: 'FAIL' });
    expect(keyless.detail).toContain('USDC decoded as symbol=null decimals=null');
    expect(keyless.remedy).toMatch(/^set ALCHEMY_API_KEY .*, or set RPC_BASE /);
    const keyed = await probeEvm('base', { env: prodEnv({ RPC_BASE: 'https://base.example/KEY' }), http, evm });
    expect(keyed.remedy).toMatch(/RPC_BASE did not run eth_call/);
  });
  it('an unreachable RPC is a FAIL with the network fix', async () => {
    const r = await probeEvm('arb', { env: prodEnv(), http: fakeHttp(() => new Error('getaddrinfo ENOTFOUND arb1.arbitrum.io')), evm: { tokenBasics: async () => usdc } });
    expect(r.status).toBe('FAIL');
    expect(r.remedy).toMatch(/no answer from arb1\.arbitrum\.io/);
  });
  it('failed sub-reads and a token read slower than a check allows are WARN', async () => {
    let t = 0;
    const evm = {
      tokenBasics: async () => {
        t += 21_000;
        reportError('evm.tokenBasics owner bnb: HTTP 429 from bsc.example');
        return { ...usdc, symbol: 'USDT', decimals: 18, owner: null };
      },
    };
    const env = prodEnv({ RPC_BSC: 'https://bsc.example/KEY' });
    const r = await probeEvm('bnb', { env, http: fakeHttp(rpcNode({ eth_chainId: '0x38', eth_blockNumber: '0x1' })), evm, now: () => t });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('1 read(s) failed: evm.tokenBasics owner bnb: HTTP 429');
    expect(r.detail).toContain('token read took 21000 ms, over the 20 s a check gives it');
  });
  it('a token read within the rounds a check allows (here 9 s of 20 s) is not flagged as slow', async () => {
    let t = 0;
    const evm = { tokenBasics: async () => ((t += 9_000), { ...usdc }) };
    const r = await probeEvm('eth', { env: prodEnv({ RPC_ETH: 'https://eth.example/KEY' }), http: fakeHttp(rpcNode({ eth_chainId: '0x1', eth_blockNumber: '0x1' })), evm, now: () => t });
    expect(r.status).toBe('PASS');
    expect(r.detail).not.toContain('over the');
  });
  it('Robinhood Chain without RPC_ROBINHOOD is SKIP; with it, liveness only', async () => {
    expect((await probeRobinhood({ env: prodEnv(), http: fakeHttp(() => new Error('unused')) })).status).toBe('SKIP');
    const r = await probeRobinhood({ env: prodEnv({ RPC_ROBINHOOD: 'https://rh.example/KEY' }), http: fakeHttp(rpcNode({ eth_chainId: '0xabc', eth_blockNumber: '0x5' })) });
    expect(r).toMatchObject({ status: 'PASS' });
    expect(r.detail).toContain('chainId 0xabc');
  });
  it('Etherscan: SKIP without a key (nothing sent); WARN listing the chains the plan does not cover', async () => {
    const creator = vi.fn(async () => null);
    expect((await probeEtherscan({ env: prodEnv(), evm: { creator } })).status).toBe('SKIP');
    expect(creator).not.toHaveBeenCalled();
    const partial = {
      creator: vi.fn(async (chain: string) => {
        if (chain === 'base') {
          reportError('evm.creator: Free API access is not supported for this chain');
          return null;
        }
        return { creator: '0xabc', txHash: null, createdAt: null };
      }),
    };
    const r = await probeEtherscan({ env: prodEnv({ ETHERSCAN_API_KEY: 'K'.repeat(20) }), evm: partial });
    expect(r.status).toBe('WARN');
    expect(r.detail).toBe('api.etherscan.io: creator found on eth, bnb, arb; not on base (evm.creator: Free API access is not supported for this chain)');
  });
});

describe('Solana probe', () => {
  const mint = { exists: true, decimals: 6, supply: '1', mintAuthority: 'Auth', freezeAuthority: 'Frz', token2022: false };
  const holders = [{ owner: 'O', account: 'A', amount: '1', pct: 10 }];
  it('the public endpoint answering is WARN (keyless) with the fix naming HELIUS_API_KEY', async () => {
    const r = await probeSolana({ env: prodEnv(), sol: { mintInfo: async () => mint, largestHolders: async () => holders } });
    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/^api\.mainnet-beta\.solana\.com \(public fallback/);
    expect(r.remedy).toMatch(/HELIUS_API_KEY/);
  });
  it('a USDC mint that does not exist means a non-mainnet endpoint', async () => {
    const r = await probeSolana({ env: prodEnv({ RPC_SOLANA: 'https://devnet.example/KEY' }), sol: { mintInfo: async () => ({ ...mint, exists: false }), largestHolders: async () => holders } });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('not a mainnet endpoint?');
  });
  it('holders refused by a keyed endpoint is WARN with the reason', async () => {
    const sol = {
      mintInfo: async () => mint,
      largestHolders: async () => {
        reportError('solana.largestHolders: HTTP 429 from mainnet.helius-rpc.com');
        return [];
      },
    };
    const r = await probeSolana({ env: prodEnv({ HELIUS_API_KEY: 'h'.repeat(20) }), sol });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('largest holders failed: solana.largestHolders: HTTP 429');
    expect(r.detail).not.toContain('h'.repeat(20));
  });
});

describe('API probes', () => {
  const jackPost = { __typename: 'Tweet', id_str: '20', text: 'just setting up my twttr', created_at: '2006-03-21T20:50:14.000Z', user: { id_str: '12', screen_name: 'jack', name: 'jack' } };
  const jackOembed = { author_name: 'jack', author_url: 'https://twitter.com/jack', html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://twitter.com/jack/status/20">March 21, 2006</a></blockquote>' };
  const host = (u: string) => new URL(u).host;
  it('X posts (free embed): PASS from the syndication endpoint, with no key and never api.x.com', async () => {
    const http = fakeHttp(url => (host(url) === 'cdn.syndication.twimg.com' ? { body: jackPost } : { status: 500 }));
    const r = await probeXRead({ http });
    expect(r).toEqual({ status: 'PASS', detail: 'cdn.syndication.twimg.com: post 20 by @jack read (free embed read, no X API credits)' });
    expect(http.calls.map(c => host(c.url))).toEqual(['cdn.syndication.twimg.com']);
    expect(http.calls[0].req.headers?.authorization).toBeUndefined();
  });
  it('X posts (free embed): WARN when only the oEmbed fallback works, WARN with both reasons when neither does', async () => {
    const half = fakeHttp(url => (host(url) === 'publish.twitter.com' ? { body: jackOembed } : { status: 403, body: 'blocked' }));
    const r = await probeXRead({ http: half });
    expect(r.status).toBe('WARN');
    expect(r.detail).toBe('cdn.syndication.twimg.com: HTTP 403 from cdn.syndication.twimg.com; the oEmbed fallback (publish.twitter.com) works: posts are read, their links only as the shortened text');
    expect(r.remedy).toMatch(/x-embed\.ts/);

    const down = fakeHttp(url => (host(url) === 'publish.twitter.com' ? new Error('getaddrinfo ENOTFOUND publish.twitter.com') : { status: 503 }));
    const d = await probeXRead({ http: down });
    expect(d.status).toBe('WARN');
    expect(d.detail).toContain('cdn.syndication.twimg.com: HTTP 503 from cdn.syndication.twimg.com; publish.twitter.com: ');
    expect(d.detail).toContain("(X post checks can't read posts)");
    expect(d.remedy).toBeTruthy();
    expect([...half.calls, ...down.calls].some(c => host(c.url) === 'api.x.com')).toBe(false);
  });
  it('X bot: SKIP without keys, FAIL when partly set, a signed users/me that never follows redirects', async () => {
    const none = fakeHttp(() => ({ status: 500 }));
    expect((await probeXBot({ env: prodEnv(), http: none })).status).toBe('SKIP');
    const part = await probeXBot({ env: prodEnv({ X_API_KEY: 'k'.repeat(10), X_API_SECRET: 's'.repeat(10) }), http: none });
    expect(part).toMatchObject({ status: 'FAIL' });
    expect(part.detail).toContain('X_ACCESS_TOKEN, X_ACCESS_SECRET empty');
    expect(none.calls).toHaveLength(0);

    const keys = { X_API_KEY: 'k'.repeat(10), X_API_SECRET: 's'.repeat(10), X_ACCESS_TOKEN: 't'.repeat(10), X_ACCESS_SECRET: 'u'.repeat(10) };
    const me = fakeHttp(() => ({ body: { data: { id: '123', username: 'RealBot' } } }));
    const r = await probeXBot({ env: prodEnv(keys), http: me });
    expect(r.status).toBe('WARN');
    expect(r.remedy).toBe('set X_BOT_USER_ID=123; set X_BOT_HANDLE=RealBot; set X_BEARER_TOKEN too');
    expect(me.calls[0].url).toBe('https://api.x.com/2/users/me');
    expect(me.calls[0].req).toMatchObject({ redirect: false });
    expect(me.calls[0].req.headers?.authorization).toMatch(/^OAuth .*oauth_signature_method="HMAC-SHA1"/);

    const wrong = await probeXBot({ env: prodEnv({ ...keys, X_BOT_USER_ID: '999' }), http: me });
    expect(wrong.status).toBe('FAIL');
    expect(wrong.remedy).toBe('set X_BOT_USER_ID=123, or use the bot account\'s access token');
  });
  it('variables of a retired coin data service left in .env are ignored: no probe, no env key, no error', () => {
    const env = prodEnv({ FOURTIS_API_URL: 'https://f.example/api/', FOURTIS_API_KEY: 'f'.repeat(16) });
    expect(Object.keys(env).filter(k => k.startsWith('FOURTIS'))).toEqual([]);
    const probes = buildProbes({ env, http: fakeHttp(() => ({ status: 404 })), sources: {} as never } as never).map(p => p.name);
    expect(probes).toContain('Etherscan V2');
    expect(probes.filter(n => /fourtis/i.test(n))).toEqual([]);
  });
  it('DexScreener: WARN when only the chain-less lookup fails', async () => {
    const pepe = { chain: 'eth', symbol: 'PEPE', priceUsd: 0.00001, liquidityUsd: 25_000_000, dex: 'uniswap' };
    const token = async (chain: string | null) => {
      if (chain) return pepe as never;
      reportError('dexscreener.token: HTTP 404 from api.dexscreener.com');
      return null;
    };
    const r = await probeDexScreener({ env: prodEnv(), dex: { token } });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('PEPE price $0.00001, liquidity $25.0M on uniswap; chain-less lookup /latest/dex/tokens failed');
  });
  it('GitHub: a rejected token is a FAIL (there is no anonymous fallback)', async () => {
    const fromUrl = vi.fn(async () => []);
    const r = await probeGitHub({ env: prodEnv({ GITHUB_TOKEN: 'g'.repeat(20) }), http: fakeHttp(() => ({ status: 401, body: { message: 'Bad credentials' } })), github: { fromUrl } });
    expect(r.status).toBe('FAIL');
    expect(fromUrl).not.toHaveBeenCalled();
  });
});

describe('AI probes', () => {
  it('WARN without a key: nothing is called', async () => {
    const ai = { extractClaims: vi.fn(), answer: vi.fn() };
    const r = await probeAi('fast', { env: prodEnv(), ai });
    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/AI: heuristic/);
    expect(ai.extractClaims).not.toHaveBeenCalled();
  });
  it('PASS when the model answers on the pipeline path', async () => {
    const ai = { extractClaims: vi.fn(async () => [{ kind: 'mainnet' }] as never), answer: vi.fn(async () => 'Yes, it loads.') };
    const env = prodEnv({ ANTHROPIC_API_KEY: 'sk-ant-' + 'x'.repeat(20) });
    expect(await probeAi('fast', { env, ai })).toMatchObject({ status: 'PASS' });
    expect(await probeAi('judge', { env, ai })).toMatchObject({ status: 'PASS' });
    expect(ai.extractClaims).toHaveBeenCalledTimes(1);
    expect(ai.answer).toHaveBeenCalledTimes(1);
  });
  it("an unknown model id is a FAIL naming the variable; a refusal still proves key and model (WARN)", async () => {
    const env = prodEnv({ ANTHROPIC_API_KEY: 'sk-ant-' + 'x'.repeat(20), AI_MODEL_FAST: 'claude-nope' });
    const notFound = new Anthropic.NotFoundError(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope' } }, undefined, new Headers());
    const r = await probeAi('fast', { env, ai: { extractClaims: async () => { throw notFound; }, answer: vi.fn() } });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('API error 404: model: claude-nope');
    expect(r.remedy).toMatch(/AI_MODEL_FAST=claude-nope is not a model id/);
    const refused = await probeAi('judge', { env, ai: { extractClaims: vi.fn(), answer: async () => { throw new AiOutputError('model stopped: refusal'); } } });
    expect(refused.status).toBe('WARN');
  });
});

describe('a masked key copied from a dashboard ("sk-ant-a•••")', () => {
  it('is refused before any call, saying what happened, and the worker uses the heuristic', async () => {
    const env = prodEnv({ ANTHROPIC_API_KEY: 'sk-ant-a\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022AAAA' });
    const ai = { extractClaims: vi.fn(), answer: vi.fn() };
    const r = await probeAi('fast', { env, ai });
    expect(r).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('masked key') });
    expect(ai.extractClaims).not.toHaveBeenCalled();
    expect(createAi(env).mode).toBe('heuristic');
  });
});

describe('a key with a line break', () => {
  // fetch's Headers throws `Headers.append: "<the whole key>" is an invalid header value.`
  const key = `sk-ant-api03-${'A1b2C3d4'.repeat(8)}\n${'Z9y8X7w6'.repeat(4)}`;
  const env = prodEnv({ ANTHROPIC_API_KEY: key });
  const leaks = (out: string) => {
    for (const part of key.split('\n')) for (let i = 0; i + 16 <= part.length; i += 4) if (out.includes(part.slice(i, i + 16))) return true;
    return false;
  };

  it('the doctor refuses it before any call and says how to fix it', async () => {
    const ai = { extractClaims: vi.fn(), answer: vi.fn() };
    const r = await probeAi('judge', { env, ai });
    expect(r).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('line break') });
    expect(ai.answer).not.toHaveBeenCalled();
    expect(leaks(formatReport([], [{ name: 'AI judge', ms: 0, ...r }], s => new Redactor(env).text(s)))).toBe(false);
  });
  it('an error that quotes it in full is redacted whole, never cut first', () => {
    const text = aiErrorText(new TypeError(`Headers.append: "${key}" is an invalid header value.`));
    expect(leaks(new Redactor(env).text(text))).toBe(false);
  });
  it('the worker never builds a client with it: AI stages use the heuristic', () => {
    expect(createAi(env).mode).toBe('heuristic');
    expect(createAi(prodEnv({ ANTHROPIC_API_KEY: 'sk-ant-' + 'x'.repeat(40) })).mode).toBe('anthropic');
  });
});

describe('infrastructure probes', () => {
  it('Postgres: a migration this checkout ships but the database lacks is a FAIL', async () => {
    const env = prodEnv({ DATABASE_URL: 'postgresql://u:longpassword@db:5432/apecheck' });
    const db = { version: async () => '16.4 (Ubuntu 16.4-1)', applied: async () => ['001_init'] };
    const ok = await probePostgres({ env, db, migrations: ['001_init'] });
    expect(ok).toEqual({ status: 'PASS', detail: 'db:5432/apecheck, PostgreSQL 16.4, 1 migrations applied' });
    const behind = await probePostgres({ env, db, migrations: ['001_init', '002_next'] });
    expect(behind.status).toBe('FAIL');
    expect(behind.remedy).toMatch(/prisma migrate deploy/);
  });
  it('Redis: counts BullMQ workers per queue from CLIENT LIST; WARN when nothing consumes "checks"', async () => {
    const b64 = (q: string) => Buffer.from(q).toString('base64');
    const list = [
      `id=1 addr=127.0.0.1:1 name=bull:${b64('checks')} db=0`,
      `id=2 addr=127.0.0.1:2 name=bull:${b64('checks')}:w:second db=0`,
      `id=3 addr=127.0.0.1:3 name=bull:${b64('prices')} db=0`,
      `id=4 addr=127.0.0.1:4 name= db=0`,
      // another configuration's worker in another database is not this one's
      `id=5 addr=127.0.0.1:5 name=bull:${b64('checks')} db=2`,
    ].join('\n');
    expect(bullWorkers(list, 'checks')).toBe(2);
    expect(bullWorkers(list, 'checks', 2)).toBe(1);
    expect(bullWorkers(list, 'asks')).toBe(0);
    const redis = (clients: string) => ({ ping: async () => 'PONG', info: async () => 'redis_version:7.2.4\r\n', call: async () => clients });
    const up = await probeRedis({ env: prodEnv(), redis: redis(list) });
    expect(up.status).toBe('PASS');
    expect(up.detail).toContain('Redis 7.2.4, PING PONG; workers per queue: checks 2, bot-replies 0, prices 1');
    expect((await probeRedis({ env: prodEnv(), redis: redis('') })).status).toBe('WARN');
  });
  it('browser host: FAIL in production without BROWSER_WS_ENDPOINT, SKIP in dev', async () => {
    const browser = vi.fn();
    const http = fakeHttp(() => ({ status: 200, body: 'Running' }));
    expect((await probeBrowserHost({ env: prodEnv(), http, browser })).status).toBe('FAIL');
    expect((await probeBrowserHost({ env: getEnv({ NODE_ENV: 'development' }), http, browser })).status).toBe('SKIP');
    expect(browser).not.toHaveBeenCalled();
  });
  it("browser via guard: never connects while worker-checks' guard port is closed; a port the firewall does not allow is a FAIL", async () => {
    const endpoint = 'ws://127.0.0.1:9223/' + 'p'.repeat(64);
    const env = prodEnv({ BROWSER_WS_ENDPOINT: endpoint, BROWSER_GUARD_PORT: '9224' });
    const browser = vi.fn();
    const http = fakeHttp(() => ({ status: 200 }));
    const closed = await probeBrowserGuard({ env, http, browser, firewallPort: 9224, portOpen: async () => false });
    expect(closed.status).toBe('WARN');
    expect(closed.detail).toMatch(/nothing listens on 127\.0\.0\.1:9224/);
    expect(browser).not.toHaveBeenCalled();
    const mismatch = await probeBrowserGuard({ env: prodEnv({ BROWSER_WS_ENDPOINT: endpoint, BROWSER_GUARD_PORT: '9300' }), http, browser, firewallPort: 9224 });
    expect(mismatch.status).toBe('FAIL');
    expect(mismatch.remedy).toMatch(/BROWSER_GUARD_PORT=9224/);
  });
  it("connectThrough reads the guard's refusal", async () => {
    const guard = await startGuardProxy({ production: true, allowHosts: [], port: 0, lookup: async () => ['127.0.0.1'] });
    try {
      const r = await connectThrough(guard.url, 'blocked.test:443', 5_000);
      expect(r.status).toBe(403);
      expect(r.reason).toMatch(/Blocked by ApeCheck SSRF guard: .*loopback/);
    } finally {
      await guard.close();
    }
  });
});

describe('header', () => {
  it('shows the AI mode, the hint to run as apecheck and every endpoint by host only', () => {
    const env = prodEnv({ RPC_ETH: 'https://eth-mainnet.g.alchemy.com/v2/KEY123', HELIUS_API_KEY: 'h'.repeat(20) });
    const lines = headerLines(env, { envFile: '/srv/apecheck/app/.env', envFileExists: true, user: 'root', now: new Date(0) });
    const text = lines.join('\n');
    expect(text).toContain('running as root (PM2 runs as apecheck: sudo -iu apecheck, then cd /srv/apecheck/app && pnpm diagnose)');
    expect(text).toContain('AI mode    heuristic (ANTHROPIC_API_KEY empty');
    expect(text).toMatch(/Ethereum +eth-mainnet\.g\.alchemy\.com +RPC_ETH/);
    expect(text).toMatch(/Solana +mainnet\.helius-rpc\.com +HELIUS_API_KEY/);
    expect(text).toMatch(/Robinhood Chain +- +not configured \(RPC_ROBINHOOD empty\)/);
    expect(text).not.toContain('KEY123');
    expect(text).not.toContain('h'.repeat(20));
  });
  it('ALCHEMY_API_KEY keys Ethereum, Base and Arbitrum (host only, key redacted); BNB stays on its public node', () => {
    const env = prodEnv({ ALCHEMY_API_KEY: 'alcKEYsecret123' });
    const text = headerLines(env, { envFile: '/srv/apecheck/app/.env', envFileExists: true, user: 'apecheck', now: new Date(0) }).join('\n');
    expect(text).toMatch(/Base +base-mainnet\.g\.alchemy\.com +ALCHEMY_API_KEY/);
    expect(text).toMatch(/Ethereum +eth-mainnet\.g\.alchemy\.com +ALCHEMY_API_KEY/);
    expect(text).toMatch(/Arbitrum +arb-mainnet\.g\.alchemy\.com +ALCHEMY_API_KEY/);
    expect(text).toMatch(/BNB Chain +bsc-dataseed\.binance\.org +public fallback \(RPC_BSC empty\)/);
    expect(text).not.toContain('alcKEYsecret123');
    expect(new Redactor(env).text('GET https://eth-mainnet.g.alchemy.com/v2/alcKEYsecret123 failed')).not.toContain('alcKEYsecret123');
  });
});
