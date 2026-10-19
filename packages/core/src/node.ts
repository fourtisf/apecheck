/**
 * Node-only helpers (fs/path). Import from "@apecheck/core/node", never from browser code.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { getEnv, resetEnvCache, type Env } from './env';

/** Walk up from `start` until a directory containing pnpm-workspace.yaml is found. */
export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

/**
 * The env file every process reads: `APECHECK_ENV_FILE` when set (absolute, or relative to the repo root),
 * else `<repo root>/.env`. The escape hatch lets one checkout run a second configuration (a staging/PM2 boot
 * test, a one-off script) without editing the deploy's .env.
 */
export function envFilePath(root = findRepoRoot(), source: Record<string, string | undefined> = process.env): string {
  const chosen = source.APECHECK_ENV_FILE?.trim();
  if (chosen) return path.isAbsolute(chosen) ? chosen : path.join(root, chosen);
  return path.join(root, '.env');
}

/**
 * Load the env file (see envFilePath) into process.env and return the parsed Env.
 *
 * Outside tests the file wins over inherited variables (override), so a deploy is configured by its .env only
 * and a stray shell variable (e.g. a GITHUB_TOKEN or ANTHROPIC_BASE_URL of the machine) can't leak in.
 * Under NODE_ENV=test the inherited variables win instead: test runners set DATABASE_URL / REDIS_URL to
 * isolated test databases, and loading the .env must never point a test at the dev database.
 * `opts.override` forces either behaviour.
 */
export function loadEnv(opts: { file?: string; override?: boolean } = {}): Env {
  const root = findRepoRoot();
  const file = opts.file ?? envFilePath(root);
  const override = opts.override ?? process.env.NODE_ENV !== 'test';
  if (fs.existsSync(file)) dotenv.config({ path: file, override, quiet: true } as dotenv.DotenvConfigOptions);
  else if (process.env.APECHECK_ENV_FILE && !opts.file) console.warn(`[apecheck] WARN APECHECK_ENV_FILE=${process.env.APECHECK_ENV_FILE} not found; using the inherited environment`);
  resetEnvCache();
  const env = getEnv();
  // relative SCREENSHOT_DIR is relative to the repo root, not the process cwd
  if (!path.isAbsolute(env.SCREENSHOT_DIR)) env.SCREENSHOT_DIR = path.join(root, env.SCREENSHOT_DIR);
  return env;
}

const warned = new Set<string>();
/** Log a warning once per process (used when an adapter is stubbed because a key is missing). */
export function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[apecheck] WARN ${message}`);
}
