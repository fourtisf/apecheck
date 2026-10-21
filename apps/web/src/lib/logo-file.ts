/**
 * Server only: a coin's stored logo (SCREENSHOT_DIR/logos/<sha256>.<ext>, written by the worker) as a data: URL for
 * the share card. The card never fetches an image over the network: the file is read from disk, checked again by its
 * magic bytes, and only PNG / JPEG / GIF (what satori draws) are embedded; anything else gives null (no logo).
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { LOGO_MAX_BYTES, LOGO_MIME, LOGO_PATH_RE, sniffImage } from '@apecheck/core';

/** core env.ts default */
const DEFAULT_SHOTS = './.data/shots';

function repoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

/** SCREENSHOT_DIR as the worker sees it (next.config.mjs loads the repo-root .env; relative paths are from the repo root). */
export function screenshotDir(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const raw = env.SCREENSHOT_DIR?.trim() || DEFAULT_SHOTS;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot(cwd), raw);
}

/** "/shots/logos/<sha>.<ext>" (CheckSummaryDTO.logo) → data URL, or null when absent, unreadable or not drawable. */
export async function logoDataUrl(logo: string | null | undefined, dir: string = screenshotDir()): Promise<string | null> {
  const m = logo ? LOGO_PATH_RE.exec(logo) : null;
  if (!m) return null;
  try {
    const file = path.join(dir, 'logos', `${m[1]}.${m[2]}`);
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > LOGO_MAX_BYTES) return null;
    const buf = await fs.readFile(file);
    const type = sniffImage(buf);
    if (!type || type === 'webp') return null;
    return `data:${LOGO_MIME[type]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}
