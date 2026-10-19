import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFilePath, findRepoRoot, loadEnv } from '../src/node';

const KEYS = ['NODE_ENV', 'APECHECK_ENV_FILE', 'DATABASE_URL', 'REDIS_URL', 'GITHUB_TOKEN', 'SCREENSHOT_DIR'] as const;

describe('loadEnv', () => {
  let saved: Record<string, string | undefined>;
  let dir: string;
  const write = (name: string, body: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, body);
    return f;
  };

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apecheck-env-'));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets the .env win over inherited variables outside tests', () => {
    const file = write('prod.env', 'DATABASE_URL=postgresql://from-file/db\nGITHUB_TOKEN=\n');
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://inherited/db';
    process.env.GITHUB_TOKEN = 'machine-token';
    const env = loadEnv({ file });
    expect(env.DATABASE_URL).toBe('postgresql://from-file/db');
    // an empty value in the file blanks the machine's own variable: the deploy is configured by its .env only
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('never lets the .env repoint a test run (NODE_ENV=test) at another database', () => {
    const file = write('dev.env', 'NODE_ENV=development\nDATABASE_URL=postgresql://dev/apecheck\nREDIS_URL=redis://localhost:6379\n');
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://localhost/apecheck_test_x';
    process.env.REDIS_URL = 'redis://localhost:6379/3';
    const env = loadEnv({ file });
    expect(env.DATABASE_URL).toBe('postgresql://localhost/apecheck_test_x');
    expect(env.REDIS_URL).toBe('redis://localhost:6379/3');
    expect(env.NODE_ENV).toBe('test');
  });

  it('reads the file named by APECHECK_ENV_FILE (relative to the repo root or absolute)', () => {
    const root = findRepoRoot();
    expect(envFilePath(root, {})).toBe(path.join(root, '.env'));
    expect(envFilePath(root, { APECHECK_ENV_FILE: 'deploy/staging.env' })).toBe(path.join(root, 'deploy/staging.env'));
    const file = write('staging.env', 'NODE_ENV=production\nSCREENSHOT_DIR=/var/apecheck/staging-shots\n');
    expect(envFilePath(root, { APECHECK_ENV_FILE: file })).toBe(file);

    process.env.NODE_ENV = 'development';
    process.env.APECHECK_ENV_FILE = file;
    const env = loadEnv();
    expect(env.NODE_ENV).toBe('production');
    expect(env.SCREENSHOT_DIR).toBe('/var/apecheck/staging-shots');
  });

  it('resolves a relative SCREENSHOT_DIR against the repo root', () => {
    const file = write('rel.env', 'SCREENSHOT_DIR=./.data/shots\n');
    process.env.NODE_ENV = 'production';
    expect(loadEnv({ file }).SCREENSHOT_DIR).toBe(path.join(findRepoRoot(), '.data/shots'));
  });
});
