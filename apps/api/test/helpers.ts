/** Test harness: an app wired to the isolated test DB / Redis db, cookie-jar clients, row fixtures. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { Queue } from 'bullmq';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Redis } from 'ioredis';
import { secp256k1 } from '@noble/curves/secp256k1';
import { QUEUES, SESSION_COOKIE, SID_COOKIE, getEnv, type AuthNonceResponse, type CheckJob, type ChainKey, type Env, type MeDTO } from '@apecheck/core';
import { Prisma, PrismaClient } from '@apecheck/db';
import { base58Encode, type DexTokenInfo, type Http, type HttpRequest, type HttpResponse } from '@apecheck/sources';
import { addressOfPublicKey, personalSignHash } from '../src/auth/evm';
import { createAskBroker } from '../src/asks';
import type { ApiSources, AskBroker } from '../src/context';
import { ChannelHub } from '../src/redis';
import { buildServer } from '../src/server';
import { TEST_DB_URL, TEST_REDIS_URL } from './global-setup';

export const APP_URL = 'http://app.test';

export function testEnv(overrides: Record<string, string> = {}): Env {
  return getEnv({
    NODE_ENV: 'test',
    APP_URL,
    API_URL: 'http://api.test',
    CORS_ORIGINS: 'http://localhost:3000',
    SESSION_SECRET: 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef',
    DATABASE_URL: TEST_DB_URL,
    REDIS_URL: TEST_REDIS_URL,
    FREE_CHECKS_PER_DAY: '5',
    CACHE_HOURS: '6',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

/* ---------------- fake data sources (no RPC, DexScreener or X in tests) ---------------- */

export interface FakeHttpCall {
  url: string;
  req: HttpRequest;
}
export type FakeHttpHandler = (url: URL, req: HttpRequest) => { status?: number; json?: unknown; text?: string } | undefined;

/** Everything the API reads from outside, controlled by the test (mutate the fields between requests). */
export class FakeSources implements ApiSources {
  /** owner → whole tokens; null = the read fails; missing = 0 */
  balances = new Map<string, number | null>();
  balanceCalls: { chain: ChainKey; token: string; owner: string }[] = [];
  /** `${chain}:${address lowercase}` → EIP-1271 answer (missing = false) */
  erc1271 = new Map<string, boolean | null>();
  erc1271Calls: { chain: ChainKey; address: string; hash: string; signature: string }[] = [];
  /** DexScreener quote of the token; null = no pair */
  quote: Pick<DexTokenInfo, 'priceUsd' | 'ch24'> | null = null;
  dexCalls = 0;
  httpCalls: FakeHttpCall[] = [];
  httpHandlers: FakeHttpHandler[] = [];

  readonly evm = {
    tokenBalance: async (chain: ChainKey, token: string, owner: string) => {
      this.balanceCalls.push({ chain, token, owner });
      const v = this.balances.get(owner) ?? this.balances.get(owner.toLowerCase());
      return v === undefined ? 0 : v;
    },
    isValidSignature: async (chain: ChainKey, address: string, hash: string, signature: string) => {
      this.erc1271Calls.push({ chain, address, hash, signature });
      const v = this.erc1271.get(`${chain}:${address.toLowerCase()}`);
      return v === undefined ? false : v;
    },
  };
  readonly sol = {
    tokenBalance: async (owner: string, mint: string) => {
      this.balanceCalls.push({ chain: 'sol', token: mint, owner });
      const v = this.balances.get(owner);
      return v === undefined ? 0 : v;
    },
  };
  readonly dex = {
    token: async (_chain: ChainKey | null, address: string): Promise<DexTokenInfo | null> => {
      this.dexCalls++;
      if (!this.quote) return null;
      return {
        chain: 'sol', address, name: 'ApeCheck', symbol: 'APECHECK', priceUsd: this.quote.priceUsd, mc: null, fdv: null, liquidityUsd: null,
        vol5m: null, vol24h: null, ch24: this.quote.ch24, pairAddress: null, pairUrl: null, dex: null, pairCreatedAt: null, websites: [], socials: [], imageUrl: null,
      };
    },
  };
  readonly http: Http = {
    request: async (url: string, req: HttpRequest = {}): Promise<HttpResponse> => {
      this.httpCalls.push({ url, req });
      const u = new URL(url);
      let r: ReturnType<FakeHttpHandler>;
      for (const h of this.httpHandlers) if ((r = h(u, req))) break;
      r ??= { status: 599, text: `no fake route for ${url}` };
      const status = r.status ?? 200;
      const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
      return { status, ok: status >= 200 && status < 300, url, finalUrl: url, headers: {}, text, truncated: false, ms: 1 };
    },
    json: async <T>(url: string, req?: HttpRequest): Promise<T> => JSON.parse((await this.http.request(url, req)).text) as T,
  };
}

export interface HarnessOptions {
  sources?: FakeSources;
  /** how long POST /v1/checks/:id/asks waits for the worker */
  askWaitMs?: number;
  /** record the SQL of every Prisma query in `queries` */
  logQueries?: boolean;
}

export interface Harness {
  app: FastifyInstance;
  env: Env;
  prisma: PrismaClient;
  redis: Redis;
  queue: Queue<CheckJob>;
  hub: ChannelHub;
  sources: FakeSources;
  asks: AskBroker;
  shotsDir: string;
  /** temp dir holding shotsDir (files here are outside what /shots may serve) */
  tmpRoot: string;
  /** a separate connection for publishing pub/sub messages in tests */
  publisher: Redis;
  /** the SQL of every Prisma query so far, with `logQueries` (clear it between steps) */
  queries: string[];
  close(): Promise<void>;
}

export async function makeHarness(envOverrides: Record<string, string> = {}, opts: HarnessOptions = {}): Promise<Harness> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apecheck-api-test-'));
  const shotsDir = path.join(tmpRoot, 'shots');
  fs.mkdirSync(shotsDir);
  const env = testEnv({ SCREENSHOT_DIR: shotsDir, ...envOverrides });
  // TEST_DB_URL unless a test overrides DATABASE_URL (e.g. to run the session in another TimeZone)
  const prisma = opts.logQueries
    ? new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] })
    : new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  const queries: string[] = [];
  if (opts.logQueries) (prisma as unknown as { $on(e: 'query', cb: (ev: { query: string }) => void): void }).$on('query', ev => queries.push(ev.query));
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  const queueConn = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<CheckJob>(QUEUES.checks, { connection: queueConn });
  const hub = new ChannelHub(new Redis(TEST_REDIS_URL));
  const publisher = new Redis(TEST_REDIS_URL);
  const sources = opts.sources ?? new FakeSources();
  const asks = createAskBroker(env, { waitMs: opts.askWaitMs ?? 5_000 });
  const app = await buildServer({ env, prisma, redis, hub, queue, sources, asks, logger: false });
  await app.ready();
  return {
    app,
    env,
    prisma,
    redis,
    queue,
    hub,
    sources,
    asks,
    shotsDir,
    tmpRoot,
    publisher,
    queries,
    async close() {
      await app.close();
      await asks.close();
      await queue.close();
      await queueConn.quit();
      await hub.close();
      await publisher.quit();
      await redis.quit();
      await prisma.$disconnect();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** TEST_DB_URL with the Postgres session TimeZone set (what a server whose Postgres isn't on UTC gets). */
export function dbUrlInTimeZone(tz: string): string {
  const u = new URL(TEST_DB_URL);
  u.searchParams.set('options', `-c TimeZone=${tz}`);
  return u.toString();
}

const TABLES = [
  'Notification', 'NoteVote', 'Note', 'Ask', 'BotMention', 'Watch', 'ApiKey', 'Webhook', 'PricePoint',
  'CoinFacts', 'Claim', 'CheckStep', 'Check', 'Deployer', 'Target', 'User',
];

export async function resetState(h: Pick<Harness, 'prisma' | 'redis'>) {
  await h.prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await h.redis.flushdb();
}

/* ---------------- HTTP client with a cookie jar ---------------- */

/** A browser: a cookie jar (every cookie the API sets, cleared ones dropped) and a fixed IP. */
export class Client {
  jar = new Map<string, string>();
  /** the raw Set-Cookie lines of the last response */
  lastSetCookie: string[] = [];
  constructor(
    private readonly app: FastifyInstance,
    readonly ip = '203.0.113.10',
  ) {}

  /** the Cookie header this client sends (assignable, e.g. to move a cookie to another client) */
  get cookie(): string | null {
    return this.jar.size ? [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') : null;
  }
  set cookie(v: string | null) {
    this.jar.clear();
    for (const part of (v ?? '').split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) this.jar.set(part.slice(0, i), part.slice(i + 1));
    }
  }

  async req(opts: InjectOptions) {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip, ...(opts.headers as Record<string, string>) };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.inject({ ...opts, headers });
    const set = res.headers['set-cookie'];
    const list = Array.isArray(set) ? set : set ? [set] : [];
    this.lastSetCookie = list;
    for (const c of list) {
      const m = c.match(/^([^=;]+)=([^;]*)/);
      if (!m) continue;
      const cleared = !m[2] || /;\s*Max-Age=0/i.test(c) || /;\s*Expires=Thu, 01 Jan 1970/i.test(c);
      if (cleared) this.jar.delete(m[1]);
      else this.jar.set(m[1], m[2]);
    }
    return res;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.req({ method: 'GET', url, headers });
  }

  post(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.req({ method: 'POST', url, payload: payload as InjectOptions['payload'], headers });
  }

  delete(url: string, headers?: Record<string, string>) {
    return this.req({ method: 'DELETE', url, headers });
  }

  private unsigned(app: FastifyInstance, name: string): string | null {
    const raw = this.jar.get(name);
    if (!raw) return null;
    const un = app.unsignCookie(decodeURIComponent(raw));
    return un.valid ? un.value : null;
  }

  /** the unsigned sid this client holds */
  sid(app: FastifyInstance): string | null {
    return this.unsigned(app, SID_COOKIE);
  }

  /** the unsigned session id this client holds (signed in) */
  session(app: FastifyInstance): string | null {
    return this.unsigned(app, SESSION_COOKIE);
  }
}

/* ---------------- wallets that really sign (keys generated per test) ---------------- */

export class EvmWallet {
  readonly chain = 'evm' as const;
  readonly priv: Uint8Array;
  readonly address: string;
  constructor(priv?: Uint8Array) {
    this.priv = priv ?? secp256k1.utils.randomPrivateKey();
    this.address = addressOfPublicKey(secp256k1.getPublicKey(this.priv, false));
  }
  /** personal_sign: r ‖ s ‖ v with v = 27/28 */
  sign(message: string, opts: { v01?: boolean } = {}): string {
    const sig = secp256k1.sign(personalSignHash(message), this.priv);
    const v = sig.recovery + (opts.v01 ? 0 : 27);
    return '0x' + Buffer.from(sig.toCompactRawBytes()).toString('hex') + v.toString(16).padStart(2, '0');
  }
}

export class SolWallet {
  readonly chain = 'sol' as const;
  readonly priv: KeyObject;
  readonly address: string;
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.priv = privateKey;
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    this.address = base58Encode(spki.subarray(spki.length - 32));
  }
  sign(message: string, encoding: 'base58' | 'base64' = 'base58'): string {
    const sig = edSign(null, Buffer.from(message, 'utf8'), this.priv);
    return encoding === 'base58' ? base58Encode(sig) : sig.toString('base64');
  }
}

export type Wallet = EvmWallet | SolWallet;

/** nonce → sign → verify; returns the verify response */
export async function signIn(c: Client, w: Wallet, opts: { address?: string } = {}) {
  const address = opts.address ?? w.address;
  const n = await c.get(`/v1/auth/nonce?chain=${w.chain}&address=${encodeURIComponent(address)}`);
  if (n.statusCode !== 200) throw new Error(`nonce ${n.statusCode}: ${n.body}`);
  const { message } = n.json<AuthNonceResponse>();
  return c.post('/v1/auth/verify', { chain: w.chain, address, message, signature: w.sign(message) });
}

/** signIn() that must succeed; returns the MeDTO */
export async function signedIn(c: Client, w: Wallet): Promise<MeDTO> {
  const res = await signIn(c, w);
  if (res.statusCode !== 200) throw new Error(`verify ${res.statusCode}: ${res.body}`);
  return res.json<MeDTO>();
}

/* ---------------- fixtures ---------------- */

let seq = 0;
const next = () => ++seq;

export interface SeedTarget extends Partial<Prisma.TargetUncheckedCreateInput> {}
export async function seedTarget(prisma: PrismaClient, t: SeedTarget = {}) {
  const n = next();
  return prisma.target.create({
    data: {
      kind: 'SITE',
      name: `site${n}.xyz`,
      domain: `site${n}.xyz`,
      key: `site:site${n}.xyz`,
      checkCount: 1,
      ...t,
    } as Prisma.TargetUncheckedCreateInput,
  });
}

export async function seedCheck(prisma: PrismaClient, c: Partial<Prisma.CheckUncheckedCreateInput> & { targetId: string }) {
  const n = next();
  const shortId = (c.shortId as string | undefined) ?? `t${String(n).padStart(6, '0')}`;
  return prisma.check.create({
    data: {
      shortId,
      targetRaw: 'raw',
      status: 'DONE',
      via: 'WEB',
      isLatest: c.status && c.status !== 'DONE' ? false : true,
      createdAt: new Date(Date.now() - 3600_000),
      startedAt: new Date(Date.now() - 3600_000),
      finishedAt: c.status && c.status !== 'DONE' && c.status !== 'FAILED' ? null : new Date(Date.now() - 1800_000),
      ...c,
    } as Prisma.CheckUncheckedCreateInput,
  });
}

export async function seedDeployer(prisma: PrismaClient, d: Partial<Prisma.DeployerUncheckedCreateInput> = {}) {
  const n = next();
  return prisma.deployer.create({
    data: {
      chain: 'SOL',
      address: `Dep${String(n).padStart(4, '0')}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
      record: 'BUILDER',
      launched: 1,
      dead: 0,
      ...d,
    } as Prisma.DeployerUncheckedCreateInput,
  });
}

export async function seedCoinFacts(prisma: PrismaClient, checkId: string, f: Partial<Prisma.CoinFactsUncheckedCreateInput> = {}) {
  return prisma.coinFacts.create({
    data: {
      checkId,
      sigDeployer: 'OK',
      sigBundle: 'OK',
      sigHolders: 'OK',
      sigLp: 'OK',
      sigAuthorities: 'OK',
      ...f,
    } as Prisma.CoinFactsUncheckedCreateInput,
  });
}

/** parse a raw SSE body into events */
export function parseSse(body: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [];
  for (const block of body.split('\n\n')) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (data.length) out.push({ event, data: JSON.parse(data.join('\n')) });
  }
  return out;
}
