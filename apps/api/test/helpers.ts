/** Test harness: an app wired to the isolated test DB / Redis db, cookie-jar clients, row fixtures. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Queue } from 'bullmq';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Redis } from 'ioredis';
import { QUEUES, SID_COOKIE, getEnv, type CheckJob, type Env } from '@apecheck/core';
import { Prisma, PrismaClient } from '@apecheck/db';
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

export interface Harness {
  app: FastifyInstance;
  env: Env;
  prisma: PrismaClient;
  redis: Redis;
  queue: Queue<CheckJob>;
  hub: ChannelHub;
  shotsDir: string;
  /** temp dir holding shotsDir (files here are outside what /shots may serve) */
  tmpRoot: string;
  /** a separate connection for publishing pub/sub messages in tests */
  publisher: Redis;
  close(): Promise<void>;
}

export async function makeHarness(envOverrides: Record<string, string> = {}): Promise<Harness> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apecheck-api-test-'));
  const shotsDir = path.join(tmpRoot, 'shots');
  fs.mkdirSync(shotsDir);
  const env = testEnv({ SCREENSHOT_DIR: shotsDir, ...envOverrides });
  // TEST_DB_URL unless a test overrides DATABASE_URL (e.g. to run the session in another TimeZone)
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
  const queueConn = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<CheckJob>(QUEUES.checks, { connection: queueConn });
  const hub = new ChannelHub(new Redis(TEST_REDIS_URL));
  const publisher = new Redis(TEST_REDIS_URL);
  const app = await buildServer({ env, prisma, redis, hub, queue, logger: false });
  await app.ready();
  return {
    app,
    env,
    prisma,
    redis,
    queue,
    hub,
    shotsDir,
    tmpRoot,
    publisher,
    async close() {
      await app.close();
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
  'NoteVote', 'Note', 'Ask', 'BotMention', 'Watch', 'ApiKey', 'Webhook', 'PricePoint',
  'CoinFacts', 'Claim', 'CheckStep', 'Check', 'Deployer', 'Target', 'User',
];

export async function resetState(h: Pick<Harness, 'prisma' | 'redis'>) {
  await h.prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await h.redis.flushdb();
}

/* ---------------- HTTP client with a cookie jar ---------------- */

export class Client {
  cookie: string | null = null;
  constructor(
    private readonly app: FastifyInstance,
    readonly ip = '203.0.113.10',
  ) {}

  async req(opts: InjectOptions) {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip, ...(opts.headers as Record<string, string>) };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.inject({ ...opts, headers });
    const set = res.headers['set-cookie'];
    const list = Array.isArray(set) ? set : set ? [set] : [];
    for (const c of list) {
      const m = c.match(new RegExp(`^${SID_COOKIE}=([^;]*)`));
      if (m) this.cookie = `${SID_COOKIE}=${m[1]}`;
    }
    return res;
  }

  get(url: string) {
    return this.req({ method: 'GET', url });
  }

  post(url: string, payload?: unknown) {
    return this.req({ method: 'POST', url, payload: payload as InjectOptions['payload'] });
  }

  /** the unsigned sid this client holds */
  sid(app: FastifyInstance): string | null {
    if (!this.cookie) return null;
    const raw = decodeURIComponent(this.cookie.slice(SID_COOKIE.length + 1));
    const un = app.unsignCookie(raw);
    return un.valid ? un.value : null;
  }
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
