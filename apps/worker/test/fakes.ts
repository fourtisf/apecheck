/**
 * FakeSources: an in-memory implementation of the Sources contract (packages/sources/src/types.ts) for
 * tests. No external network: http only reaches *.test fixture hosts on 127.0.0.1.
 */
import http from 'node:http';
import { SsrfError } from '@apecheck/sources';
import type {
  CoinRawFacts,
  DexTokenInfo,
  EvmTxRequest,
  Http,
  HttpRequest,
  HttpResponse,
  RepoFacts,
  SimResult,
  Sources,
  XPost,
  XUser,
} from '@apecheck/sources';
import type { ChainKey, Env } from '@apecheck/core';

/** http for tests: *.test hosts go to 127.0.0.1 (guard: only allow-listed host:port), nothing else. */
export function fakeHttp(allowHosts: string[]): Http {
  async function request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const started = Date.now();
    const u = new URL(url);
    if (!/\.test$/i.test(u.hostname)) {
      if (req.guard) throw new SsrfError(`could not resolve ${u.hostname}`);
      throw new Error(`network disabled in tests: ${u.host}`);
    }
    if (req.guard && !allowHosts.includes(u.host)) throw new SsrfError(`${u.hostname} resolves to loopback 127.0.0.1`);
    return new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: Number(u.port || 80), path: u.pathname + u.search, method: req.method ?? 'GET', headers: { ...req.headers, host: u.host }, timeout: req.timeoutMs ?? 10_000 },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v != null) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
            const status = res.statusCode ?? 0;
            resolve({ status, ok: status >= 200 && status < 300, url, finalUrl: url, headers, text: Buffer.concat(chunks).toString('utf8'), truncated: false, ms: Date.now() - started });
          });
        },
      );
      r.on('error', reject);
      r.on('timeout', () => r.destroy(new Error('timeout')));
      if (req.body) r.write(req.body);
      r.end();
    });
  }
  return {
    request,
    async json<T>(url: string, req: HttpRequest = {}): Promise<T> {
      const res = await request(url, req);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(res.text) as T;
    },
  };
}

export interface FakeData {
  allowHosts?: string[];
  dexTokens?: Record<string, DexTokenInfo>;
  evmChains?: Record<string, ChainKey>;
  posts?: Record<string, XPost>;
  users?: Record<string, XUser>;
  /** fromUrl results keyed by "owner" or "owner/repo" (lowercase) */
  repos?: Record<string, RepoFacts[]>;
  search?: RepoFacts[];
  coinFacts?: Record<string, CoinRawFacts>;
  simulate?: SimResult;
  /** X adapter configured (defaults to true when posts/users are given) */
  xConfigured?: boolean;
}

export type FakeSources = Sources & { calls: string[]; simulated: EvmTxRequest[]; data: FakeData };

export function emptyCoinFacts(chain: ChainKey, address: string): CoinRawFacts {
  return { chain, address, token: null, deployer: null, bundle: null, holders: null, lp: null, authorities: null, market: null, stubbed: ['fourtis'], errors: [] };
}

export function fakeSources(env: Env, data: FakeData = {}): FakeSources {
  const calls: string[] = [];
  const simulated: EvmTxRequest[] = [];
  const xConfigured = data.xConfigured ?? !!(data.posts || data.users);
  const sources: FakeSources = {
    env,
    calls,
    simulated,
    data,
    http: fakeHttp(data.allowHosts ?? env.SSRF_ALLOW_HOSTS),
    dex: {
      configured: true,
      lastError: null,
      async token(chain, address) {
        calls.push(`dex.token ${address}`);
        const t = data.dexTokens?.[address.toLowerCase()];
        return t && (!chain || t.chain === chain) ? t : null;
      },
      async tokens(chain, addresses) {
        calls.push(`dex.tokens ${chain} ${addresses.length}`);
        const out = new Map<string, DexTokenInfo>();
        for (const a of addresses) {
          const t = data.dexTokens?.[a.toLowerCase()];
          if (t && t.chain === chain) out.set(a.toLowerCase(), t);
        }
        return out;
      },
      async search() {
        return [];
      },
    },
    evm: {
      lastError: null,
      chains: () => ['base', 'eth', 'bnb', 'arb'],
      async detectChain(address) {
        calls.push(`evm.detectChain ${address}`);
        return data.evmChains?.[address.toLowerCase()] ?? null;
      },
      async getCode() {
        return null;
      },
      async tokenBasics() {
        return null;
      },
      async simulate(chain, tx) {
        calls.push(`evm.simulate ${chain}`);
        simulated.push(tx);
        return data.simulate ?? { ok: true, error: null, gas: '120000' };
      },
      async creator() {
        return null;
      },
    },
    sol: {
      configured: true,
      lastError: null,
      async mintInfo() {
        return null;
      },
      async largestHolders() {
        return [];
      },
      async simulate() {
        calls.push('sol.simulate');
        return data.simulate ?? { ok: true, error: null, gas: '5000' };
      },
    },
    tron: { configured: false, lastError: null, async tokenInfo() { return null; } },
    github: {
      configured: true,
      lastError: null,
      async fromUrl(url) {
        calls.push(`github.fromUrl ${url}`);
        const m = /github\.com\/([^/]+)(?:\/([^/?#]+))?/i.exec(url);
        if (!m) return [];
        const key = (m[2] ? `${m[1]}/${m[2]}` : m[1]).toLowerCase();
        return data.repos?.[key] ?? data.repos?.[m[1].toLowerCase()] ?? [];
      },
      async searchByName(name) {
        calls.push(`github.search ${name}`);
        return data.search ?? [];
      },
    },
    x: {
      configured: xConfigured,
      lastError: null,
      canPost: false,
      async getPost(id) {
        calls.push(`x.getPost ${id}`);
        return xConfigured ? data.posts?.[id] ?? null : null;
      },
      async getUser(handle) {
        calls.push(`x.getUser ${handle}`);
        return xConfigured ? data.users?.[handle.toLowerCase()] ?? null : null;
      },
      async getUserById() {
        return null;
      },
      async renameCount() {
        return null;
      },
    },
    fourtis: {
      configured: false,
      lastError: null,
      async devRadar() { return null; },
      async bundleScan() { return null; },
      async whaleFlow() { return null; },
    },
    async coinFacts(chain, address) {
      calls.push(`coinFacts ${chain} ${address}`);
      return data.coinFacts?.[address.toLowerCase()] ?? emptyCoinFacts(chain, address);
    },
    stubbed: () => ['fourtis'],
  };
  return sources;
}

/* ---------------- builders ---------------- */

export function dexInfo(p: Partial<DexTokenInfo> & { chain: ChainKey; address: string }): DexTokenInfo {
  return {
    name: 'Orbit', symbol: 'ORBIT', priceUsd: 0.0123, mc: 1_230_000, fdv: 1_300_000, liquidityUsd: 210_000, vol5m: 4_200, vol24h: 380_000, ch24: 6.1,
    pairAddress: '0x' + 'ab'.repeat(20), pairUrl: 'https://dexscreener.com/base/0xpair', dex: 'uniswap', pairCreatedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    websites: [], socials: [], imageUrl: null,
    ...p,
  };
}

export function repoFacts(p: Partial<RepoFacts> & { fullName: string }): RepoFacts {
  const now = Date.now();
  return {
    url: `https://github.com/${p.fullName}`, fork: false, stars: 40, createdAt: new Date(now - 400 * 86_400_000).toISOString(),
    pushedAt: new Date(now - 2 * 86_400_000).toISOString(), commits: 412, contributors: 6,
    firstCommit: new Date(now - 400 * 86_400_000).toISOString(), lastCommit: new Date(now - 2 * 86_400_000).toISOString(),
    recentCommitDates: Array.from({ length: 100 }, (_, i) => new Date(now - (2 + i * 3) * 86_400_000).toISOString()),
    description: null,
    ...p,
  };
}

export function xUser(p: Partial<XUser> & { handle: string }): XUser {
  return {
    id: '1', name: p.handle, createdAt: new Date(Date.now() - 820 * 86_400_000).toISOString(), followers: 41_200, following: 300, verified: false,
    description: null, url: null, bioUrls: [], pinnedTweetId: null, pinnedText: null,
    ...p,
  };
}
