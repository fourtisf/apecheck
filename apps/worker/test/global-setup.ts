/**
 * Creates the isolated test database (apecheck_test_worker) if missing, applies the migrations,
 * empties the test Redis db (2) and makes a scratch dir for screenshots (removed at the end).
 * Never touches the dev database or Redis db 0.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://apecheck:apecheck@localhost:5432/apecheck_test_worker';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function ensureDatabase() {
  const u = new URL(TEST_DB_URL);
  const name = u.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes('test')) throw new Error(`refusing to use ${name} as a test database`);
  const admin = new URL(TEST_DB_URL);
  admin.pathname = '/postgres';
  const psql = (sql: string) => execFileSync('psql', [admin.toString(), '-Atc', sql], { encoding: 'utf8' }).trim();
  if (psql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`) !== '1') psql(`CREATE DATABASE "${name}"`);
}

export default async function setup() {
  ensureDatabase();
  execFileSync('pnpm', ['--filter', '@apecheck/db', 'prisma', 'migrate', 'deploy'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
  if (!/\/(?:[1-9]|1[0-5])$/.test(TEST_REDIS_URL)) throw new Error('tests must use a non-zero Redis db');
  const redis = new Redis(TEST_REDIS_URL);
  await redis.flushdb();
  await redis.quit();
  // screenshots and cards written by the tests go here; removed when the run ends
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apecheck-worker-tests-'));
  process.env.APECHECK_TEST_TMP = scratch;
  return () => fs.rmSync(scratch, { recursive: true, force: true });
}
