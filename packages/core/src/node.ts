/**
 * Node-only helpers (fs/path/crypto). Import from "@apecheck/core/node", never from browser code.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { getEnv, resetEnvCache, type Env } from './env';

/* ---------------- webhook signatures (M4, HANDOFF §9) ---------------- */

/** how far a signed timestamp may be from the receiver's clock (seconds) */
export const WEBHOOK_TOLERANCE_S = 300;

/** hex HMAC-SHA256(secret, `${t}.${rawBody}`) */
export function webhookSignature(secret: string, body: string | Buffer, t: number): string {
  return createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
}

/**
 * The `ApeCheck-Signature` header (WEBHOOK_SIGNATURE_HEADER) for a webhook body sent at unix second `t`:
 * "t=<t>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>". Sign the exact bytes you send.
 */
export function signWebhook(secret: string, body: string | Buffer, t: number = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${webhookSignature(secret, body, t)}`;
}

export interface VerifyWebhookOptions {
  /** allowed clock difference in seconds (default WEBHOOK_TOLERANCE_S, 5 minutes) */
  toleranceS?: number;
  /** the receiver's clock in unix seconds (default now) */
  now?: number;
}

/**
 * Whether `header` (the ApeCheck-Signature value) signs `body` (the raw request body, before JSON parsing) with
 * `secret`, at a time within the tolerance of now. Several v1 entries are allowed (any may match); the comparison is
 * timing-safe. Never throws: a missing or malformed header is false.
 */
export function verifyWebhook(secret: string, body: string | Buffer, header: string | null | undefined, opts: VerifyWebhookOptions = {}): boolean {
  if (!secret || typeof header !== 'string' || header.length > 4096) return false;
  let t: number | null = null;
  const sigs: Buffer[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) sigs.push(Buffer.from(v, 'hex'));
  }
  if (t == null || !sigs.length) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceS ?? WEBHOOK_TOLERANCE_S)) return false;
  const expected = Buffer.from(webhookSignature(secret, body, t), 'hex');
  let ok = false;
  // compare against every entry (no early exit)
  for (const s of sigs) if (s.length === expected.length && timingSafeEqual(s, expected)) ok = true;
  return ok;
}

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
