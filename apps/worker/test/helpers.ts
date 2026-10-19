/** Shared test plumbing: env, database rows, a no-op step store for browser-only tests. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getEnv, detect, kindOf, kindToDb, short, targetKey, type Env } from '@apecheck/core';
import { prisma, type PrismaClient } from '@apecheck/db';
import type { Redis } from 'ioredis';
import { memoryLogger } from '../src/log';
import { HeuristicAi } from '../src/ai/heuristic';
import { ResilientAi } from '../src/ai';
import { CheckRun, type PipelineDeps } from '../src/pipeline/context';
import { StepLogger } from '../src/pipeline/steps';
import type { BrowserHost } from '../src/browser/browser';
import type { Sources } from '@apecheck/sources';

export { prisma };

/** A temp directory inside the run's scratch dir (test/global-setup.ts removes it at the end). */
export function tmpDir(prefix = 'apecheck-worker-'): string {
  return fs.mkdtempSync(path.join(process.env.APECHECK_TEST_TMP ?? os.tmpdir(), prefix));
}

export function testEnv(over: Record<string, string> = {}): Env {
  return getEnv({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    ANTHROPIC_API_KEY: '',
    CHECK_BUDGET_SECONDS: '180',
    CHECK_MAX_AGENT_ACTIONS: '6',
    MAX_CONCURRENT_BROWSERS: '1',
    WEB_INTERNAL_URL: 'http://127.0.0.1:9',
    SCREENSHOT_DIR: tmpDir('apecheck-shots-'),
    ...over,
  });
}

export async function resetDb(db: PrismaClient = prisma) {
  await db.$executeRawUnsafe(
    'TRUNCATE "CheckStep","Claim","CoinFacts","PricePoint","BotMention","Ask","NoteVote","Note","Notification","Watch","Check","Deployer","Target","User" CASCADE',
  );
}

/** Same rows POST /v1/checks creates: a Target (preliminary key) and a QUEUED Check. */
export async function createCheck(targetRaw: string, db: PrismaClient = prisma) {
  const d = detect(targetRaw);
  if (!d || d.kind === 'bad') throw new Error(`bad target ${targetRaw}`);
  const key = targetKey(d);
  const kind = kindOf(d);
  const seed = {
    kind: kindToDb(kind),
    chain: d.kind === 'sol' ? ('SOL' as const) : d.kind === 'tron' ? ('TRX' as const) : null,
    ca: d.kind === 'evm' || d.kind === 'sol' || d.kind === 'tron' ? d.address : null,
    domain: d.kind === 'site' ? d.domain : null,
    handle: d.kind === 'xpost' ? d.handle : null,
    name: d.kind === 'site' ? d.domain : d.kind === 'xpost' ? (d.handle ? `@${d.handle}` : 'X post') : short(d.address),
  };
  const target = await db.target.upsert({ where: { key }, create: { key, ...seed, checkCount: 1 }, update: { checkCount: { increment: 1 } } });
  return db.check.create({
    data: { shortId: randomBytes(5).toString('base64url').slice(0, 7), targetId: target.id, targetRaw, postId: d.kind === 'xpost' ? d.postId : null, status: 'QUEUED' },
  });
}

export function heuristicAi() {
  return new ResilientAi(null);
}
export { HeuristicAi };

/** A step store that keeps rows in memory (for browser-only tests that don't need the database). */
export function memoryStepDeps() {
  const rows: unknown[] = [];
  const db = { checkStep: { create: async (a: { data: unknown }) => { rows.push(a.data); return a.data; } } } as unknown as PrismaClient;
  const published: string[] = [];
  const redis = { set: async () => 'OK', publish: async (_c: string, m: string) => { published.push(m); return 1; } } as unknown as Redis;
  return { db, redis, rows, published };
}

/** A CheckRun wired to in-memory steps, for running single stages. */
export function standaloneRun(opts: { env: Env; sources: Sources; browser: BrowserHost | null; ai?: PipelineDeps['ai']; budgetMs?: number }) {
  const mem = memoryStepDeps();
  const log = memoryLogger();
  const deps: PipelineDeps = {
    env: opts.env,
    prisma: mem.db,
    redis: mem.redis,
    sources: opts.sources,
    ai: opts.ai ?? heuristicAi(),
    browser: async () => opts.browser,
    log,
  };
  const check = { id: 'standalone' + randomBytes(4).toString('hex'), shortId: 'abcdefg', targetId: 't', targetRaw: '', postId: null };
  const started = Date.now();
  const steps = new StepLogger({ prisma: mem.db, redis: mem.redis, screenshotDir: opts.env.SCREENSHOT_DIR, log }, check, started);
  const ctrl = new AbortController();
  const run = new CheckRun(deps, check, steps, started, started + (opts.budgetMs ?? 180_000), ctrl.signal);
  return { run, steps, mem, log, abort: () => ctrl.abort() };
}
