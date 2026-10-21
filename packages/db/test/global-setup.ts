/**
 * For the tests that read Postgres (deployers.test.ts): creates the isolated test database (apecheck_test_db) if it is
 * missing and applies the migrations to it. Never touches the dev database.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://apecheck:apecheck@localhost:5432/apecheck_test_db';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export default async function setup() {
  const u = new URL(TEST_DB_URL);
  const name = u.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(name) || !name.includes('test')) throw new Error(`refusing to use ${name} as a test database`);
  const admin = new URL(TEST_DB_URL);
  admin.pathname = '/postgres';
  const psql = (sql: string) => execFileSync('psql', [admin.toString(), '-Atc', sql], { encoding: 'utf8' }).trim();
  if (psql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`) !== '1') psql(`CREATE DATABASE "${name}"`);
  execFileSync('pnpm', ['--filter', '@apecheck/db', 'prisma', 'migrate', 'deploy'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
}
