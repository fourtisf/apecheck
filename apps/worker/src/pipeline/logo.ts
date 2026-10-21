/**
 * The coin's logo (Stage A's merged token links: DexScreener image > token metadata image > GeckoTerminal image):
 * downloaded once through the SSRF guard (1 MB cap), kept only when its bytes are a PNG, JPEG, WebP or GIF (SVG and
 * anything else refused), stored as SCREENSHOT_DIR/logos/<sha256>.<ext> and saved on Target.logo. The API serves it
 * at /shots/logos/…: visitors never load a third-party image. Never fails the check.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOGO_EXT, LOGO_MAX_BYTES, LOGO_PATH_RE, sniffImage, type LogoType } from '@apecheck/core';
import { imageUrlOf, type Http } from '@apecheck/sources';
import type { CheckRun } from './context';

export const LOGO_TIMEOUT_MS = 8_000;
/** the folder under SCREENSHOT_DIR (the screenshot cleanup never touches it) */
export const LOGOS_DIR = 'logos';

export type LogoFetch = { ok: true; bytes: Buffer; type: LogoType } | { ok: false; reason: string };

/** Download and vet one image URL (guarded fetch, binary body, size cap, magic bytes). */
export async function fetchLogo(http: Http, url: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<LogoFetch> {
  const max = opts.maxBytes ?? LOGO_MAX_BYTES;
  const src = imageUrlOf(url);
  if (!src) return { ok: false, reason: 'not an http(s) image URL' };
  let res;
  try {
    res = await http.request(src, { guard: true, binary: true, timeoutMs: opts.timeoutMs ?? LOGO_TIMEOUT_MS, maxBytes: max + 1, headers: { accept: 'image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1' } });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const bytes = res.body ?? Buffer.alloc(0);
  if (res.truncated || bytes.length > max) return { ok: false, reason: `larger than ${Math.round(max / 1024)} KB` };
  if (/svg/i.test(res.headers['content-type'] ?? '')) return { ok: false, reason: 'SVG refused' };
  const type = sniffImage(bytes);
  if (!type) return { ok: false, reason: /^\s*(<\?xml|<svg)/i.test(bytes.subarray(0, 256).toString('utf8')) ? 'SVG refused' : 'not a PNG, JPEG, WebP or GIF' };
  return { ok: true, bytes, type };
}

/** Write the image as <dir>/logos/<sha256>.<ext> (once: same bytes, same file); returns "logos/<sha256>.<ext>". */
export async function storeLogo(screenshotDir: string, bytes: Buffer, type: LogoType): Promise<string> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const rel = `${LOGOS_DIR}/${sha}.${LOGO_EXT[type]}`;
  const dir = path.join(screenshotDir, LOGOS_DIR);
  const file = path.join(screenshotDir, rel);
  await fs.mkdir(dir, { recursive: true });
  if (await exists(file)) return rel;
  const tmp = path.join(dir, `.${sha}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, file);
  return rel;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * After Stage A (the Target row is final): store the coin's logo unless the Target already has one on disk. A site or
 * post check that found a coin stores it too (the coins and deployers pages show that coin with its Target's logo).
 * Resolves to the stored path, or null (no image, refused, failed: logged, never thrown).
 */
export async function saveLogo(run: CheckRun): Promise<string | null> {
  if (!run.hasCoin()) return null;
  const url = run.tokenLinks?.image?.url ?? imageUrlOf(run.market?.imageUrl);
  if (!url) return null;
  const { prisma } = run.deps;
  try {
    const current = await prisma.target.findUnique({ where: { id: run.targetId }, select: { logo: true } });
    if (!current) return null;
    if (current.logo && LOGO_PATH_RE.test(current.logo) && (await exists(path.join(run.env.SCREENSHOT_DIR, current.logo)))) return current.logo;
    const got = await fetchLogo(run.sources.http, url);
    if (!got.ok) {
      run.log.info(`logo not kept (${safeHost(url)}): ${got.reason}`);
      return null;
    }
    const rel = await storeLogo(run.env.SCREENSHOT_DIR, got.bytes, got.type);
    await prisma.target.update({ where: { id: run.targetId }, data: { logo: rel } });
    return rel;
  } catch (e) {
    run.log.warn('logo could not be saved', e);
    return null;
  }
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return 'invalid URL';
  }
}
