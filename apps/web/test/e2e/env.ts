/**
 * Settings of the browser suite: its own database, Redis db and ports, so it never touches dev data or another
 * suite. Override with E2E_DATABASE_URL, E2E_REDIS_URL, E2E_API_PORT, E2E_WEB_PORT, E2E_HOOK_PORT, E2E_DIST_DIR.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// types only (test/tsconfig.json maps them into the worker's copy); erased at runtime
import type * as Playwright from 'playwright';

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REPO_ROOT = path.resolve(WEB_DIR, '../..');

export const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://apecheck:apecheck@localhost:5432/apecheck_test_web';
export const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379/3';
export const API_PORT = Number(process.env.E2E_API_PORT ?? 4611);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3611);
/** M4: the tests' webhook receiver; the API and worker-prices let it through the SSRF guard (SSRF_ALLOW_HOSTS) */
export const HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 4612);
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
/** `next build` output of this suite (git-ignored, like every .next-* folder); E2E_DIST_DIR for a second copy */
export const DIST_DIR = process.env.E2E_DIST_DIR ?? '.next-e2e';

/**
 * Playwright comes from @apecheck/worker (its browser agent depends on it, with Chromium in PLAYWRIGHT_BROWSERS_PATH),
 * so the web app needs no copy of its own; next.config.mjs reaches dotenv through @apecheck/core the same way.
 */
export const playwright: typeof Playwright = createRequire(path.join(REPO_ROOT, 'apps/worker/package.json'))('playwright');

/** A Prisma client on the suite's database. */
export async function openDb() {
  process.env.DATABASE_URL ??= DB_URL; // the module's singleton reads it; ours gets the URL explicitly
  const { PrismaClient } = await import('../../../../packages/db/src/index');
  return new PrismaClient({ datasourceUrl: DB_URL });
}

/** Empty the suite's Redis db (rate limits and credits count per IP, and every test comes from 127.0.0.1). */
export function flushRedis() {
  if (!/\/(?:[1-9]|1[0-5])$/.test(REDIS_URL)) throw new Error('the browser suite must use a non-zero Redis db');
  execFileSync('redis-cli', ['-u', REDIS_URL, 'FLUSHDB'], { stdio: 'pipe' });
}
