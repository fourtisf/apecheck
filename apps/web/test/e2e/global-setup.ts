/**
 * Brings up what a visitor's browser talks to, isolated from dev data:
 * 1. database apecheck_test_web (created and migrated) with the seed, Redis db 3 emptied;
 * 2. the API (apps/api, as PM2 runs it) on 127.0.0.1:4611;
 * 3. the web app built with `next build` into .next-e2e and served by `next start` on 127.0.0.1:3611
 *    (production, like the reported bugs: e.g. notFound() under /c/[id] is a client-rendered shell there);
 * 4. worker-bot (apps/worker src/bot.ts) for the follow-up questions on queue "asks" (no X keys: the bot itself idles,
 *    no ANTHROPIC_API_KEY: answers come from the heuristic stand-in);
 * 5. M4: worker-prices (apps/worker src/prices.ts) for webhook deliveries on queue "webhooks". The tests' local
 *    receiver (127.0.0.1:HOOK_PORT) is let through the SSRF guard with SSRF_ALLOW_HOSTS (development only).
 * The test wallets (wallets.ts) get Pro / Max through TIER_OVERRIDES; X_OAUTH2_CLIENT_ID is a dummy so "Link your X" shows.
 * E2E_SKIP_BUILD=1 reuses an existing .next-e2e build. Logs (api.log, worker.log, prices.log, web.log, build.log) go to a new apecheck-web-e2e- folder in the OS temp dir.
 * Teardown stops the processes it started (by their own process group), nothing else.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { API_PORT, API_URL, DB_URL, DIST_DIR, HOOK_PORT, REDIS_URL, REPO_ROOT, WEB_DIR, WEB_PORT, WEB_URL, flushRedis, openDb } from './env';
import { seed } from './seed';
import { EVM_MAX_KEY, EVM_PRO_KEY, evmAddressOf } from './wallets';

declare module 'vitest' {
  export interface ProvidedContext {
    e2eLogDir: string;
  }
}

const children: ChildProcess[] = [];

function ensureDatabase() {
  const u = new URL(DB_URL);
  const name = u.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes('test')) throw new Error(`refusing to use ${name} as a test database`);
  const admin = new URL(DB_URL);
  admin.pathname = '/postgres';
  const psql = (sql: string) => execFileSync('psql', [admin.toString(), '-Atc', sql], { encoding: 'utf8' }).trim();
  if (psql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`) !== '1') psql(`CREATE DATABASE "${name}"`);
  execFileSync('pnpm', ['--filter', '@apecheck/db', 'prisma', 'migrate', 'deploy'], { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'pipe' });
}

function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function waitFor(url: string, child: ChildProcess, log: string, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode != null) break;
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up; see ${log}:\n${tail(log)}`);
}

async function waitForLog(log: string, re: RegExp, child: ChildProcess, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && child.exitCode == null) {
    if (fs.existsSync(log) && re.test(fs.readFileSync(log, 'utf8'))) return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${log} never said ${re}:\n${tail(log)}`);
}

const tail = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(-30).join('\n') : '');

type Env = Record<string, string | undefined>;

function start(cmd: string, args: string[], cwd: string, env: Env, log: string): ChildProcess {
  const out = fs.openSync(log, 'a');
  // own process group, so teardown can stop the server and anything it forked, and only that
  const child = spawn(cmd, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', out, out], detached: true });
  children.push(child);
  return child;
}

function stopAll() {
  for (const c of children) {
    if (c.pid && c.exitCode == null) {
      try {
        process.kill(-c.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

/** `next build` rewrites tsconfig.json (adds .next-e2e/types to "include"); put the files back as they were. */
function build(env: Env, log: string) {
  const keep = ['tsconfig.json', 'next-env.d.ts'].map(f => [path.join(WEB_DIR, f), fs.readFileSync(path.join(WEB_DIR, f), 'utf8')] as const);
  try {
    execFileSync(path.join(WEB_DIR, 'node_modules/.bin/next'), ['build'], { cwd: WEB_DIR, env: env as NodeJS.ProcessEnv, stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')] });
  } catch {
    throw new Error(`next build failed; see ${log}:\n${tail(log)}`);
  } finally {
    for (const [file, text] of keep) if (fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  }
}

export default async function setup(project: TestProject) {
  for (const port of [API_PORT, WEB_PORT, HOOK_PORT]) {
    if (!(await portFree(port))) throw new Error(`port ${port} is in use: set E2E_API_PORT / E2E_WEB_PORT / E2E_HOOK_PORT`);
  }
  ensureDatabase();
  const db = await openDb();
  try {
    await seed(db);
  } finally {
    await db.$disconnect();
  }
  flushRedis();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apecheck-web-e2e-'));
  const envFile = path.join(dir, '.env');
  const vars: Record<string, string> = {
    NODE_ENV: 'development',
    APP_URL: WEB_URL,
    API_URL,
    NEXT_PUBLIC_API_URL: API_URL,
    NEXT_PUBLIC_APP_URL: WEB_URL,
    API_INTERNAL_URL: API_URL,
    API_HOST: '127.0.0.1',
    API_PORT: String(API_PORT),
    CORS_ORIGINS: WEB_URL,
    DATABASE_URL: DB_URL,
    REDIS_URL,
    SESSION_SECRET: 'e2e-only-session-secret-e2e-only-session-secret-e2e-only-0001',
    SCREENSHOT_DIR: path.join(dir, 'shots'),
    X_BOT_HANDLE: 'ApeCheckBot',
    LOG_LEVEL: 'warn',
    TIER_OVERRIDES: `${evmAddressOf(EVM_PRO_KEY)}:pro,${evmAddressOf(EVM_MAX_KEY)}:max`,
    X_OAUTH2_CLIENT_ID: 'e2e-dummy-client',
    // M4: the webhook receiver the tests start on this port (never honoured in production)
    SSRF_ALLOW_HOSTS: `127.0.0.1:${HOOK_PORT}`,
    // the bot worker must never talk to X from a test
    X_API_KEY: '',
    X_API_SECRET: '',
    X_ACCESS_TOKEN: '',
    X_ACCESS_SECRET: '',
    X_BEARER_TOKEN: '',
    ANTHROPIC_API_KEY: '',
  };
  fs.writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  // children read this file (loadEnv / next.config.mjs) and get the same values in their environment
  const { NODE_ENV: _drop, ...inherited } = process.env;
  const env: Env = { ...inherited, ...vars, APECHECK_ENV_FILE: envFile, NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: '1' };

  const buildLog = path.join(dir, 'build.log');
  if (!(process.env.E2E_SKIP_BUILD === '1' && fs.existsSync(path.join(WEB_DIR, DIST_DIR, 'BUILD_ID')))) {
    build({ ...env, NODE_ENV: 'production' }, buildLog);
  }

  const apiLog = path.join(dir, 'api.log');
  const api = start(process.execPath, ['--import', 'tsx', 'src/index.ts'], path.join(REPO_ROOT, 'apps/api'), env, apiLog);
  const workerLog = path.join(dir, 'worker.log');
  const worker = start(process.execPath, ['--import', 'tsx', 'src/bot.ts'], path.join(REPO_ROOT, 'apps/worker'), env, workerLog);
  const pricesLog = path.join(dir, 'prices.log');
  const prices = start(process.execPath, ['--import', 'tsx', 'src/prices.ts'], path.join(REPO_ROOT, 'apps/worker'), env, pricesLog);
  const webLog = path.join(dir, 'web.log');
  const web = start(path.join(WEB_DIR, 'node_modules/.bin/next'), ['start', '-p', String(WEB_PORT), '-H', '127.0.0.1'], WEB_DIR, { ...env, NODE_ENV: 'production' }, webLog);
  try {
    await waitFor(`${API_URL}/health`, api, apiLog);
    await waitFor(`${WEB_URL}/api`, web, webLog);
    await waitForLog(workerLog, /answering follow-up questions/, worker);
    await waitForLog(pricesLog, /webhooks: delivering/, prices);
  } catch (e) {
    stopAll();
    throw e;
  }
  project.provide('e2eLogDir', dir);

  return () => stopAll();
}
