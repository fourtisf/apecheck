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
 * Load the repo-root .env into process.env and return the parsed Env.
 * .env wins over inherited variables (override) so a deploy is configured by its .env only.
 */
export function loadEnv(opts: { file?: string; override?: boolean } = {}): Env {
  const root = findRepoRoot();
  const file = opts.file ?? path.join(root, '.env');
  if (fs.existsSync(file)) dotenv.config({ path: file, override: opts.override ?? true, quiet: true } as dotenv.DotenvConfigOptions);
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
