/**
 * GET /card/<id>.png — the share card as a 1200x675 PNG (HANDOFF §3), used by the bot's replies,
 * og:image on reports and the share modal's "Download image".
 */
import fs from 'node:fs';
import { ImageResponse } from 'next/og';
import type { CheckReportDTO } from '@apecheck/core';
import { isApiError, report } from '@/lib/api';
import { serverCall } from '@/lib/server-api';
import { CARD_FONT, CARD_H, CARD_W, ShareCardImage } from '@/components/pages/ShareCardImage';
import { logoDataUrl } from '@/lib/logo-file';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/*
 * satori reads woff/ttf (not woff2); load once per process. webpack swaps `require` and `createRequire` in this bundle
 * for its own module map (which has no .woff files), so resolve through Node's real require.
 */
declare const __non_webpack_require__: NodeRequire;
const font = (pkg: string, file: string) => {
  const b = fs.readFileSync(__non_webpack_require__.resolve(`${pkg}/files/${file}`));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const jakarta = (subset: 'latin' | 'latin-ext', weight: 400 | 700 | 800) => ({
  name: CARD_FONT,
  data: font('@fontsource/plus-jakarta-sans', `plus-jakarta-sans-${subset}-${weight}-normal.woff`),
  weight,
  style: 'normal' as const,
});
const FONTS = [
  jakarta('latin', 400),
  jakarta('latin', 700),
  jakarta('latin', 800),
  jakarta('latin-ext', 400),
  jakarta('latin-ext', 700),
  jakarta('latin-ext', 800),
  // not used for any text on the card: satori falls back to it for symbols Jakarta lacks, like arrows
  { name: 'Geist Mono', data: font('@fontsource/geist-mono', 'geist-mono-latin-500-normal.woff'), weight: 500 as const, style: 'normal' as const },
];
/** Glyphs outside the bundled fonts (CJK, emoji) are downloaded by next/og; past this, draw without them. */
const FULL_RENDER_MS = 5000;

const draw = (item: CheckReportDTO, strict: boolean, logo: string | null) =>
  new ImageResponse(<ShareCardImage item={item} strict={strict} logo={logo} />, { width: CARD_W, height: CARD_H, fonts: FONTS }).arrayBuffer();

/**
 * Render with every glyph if the downloads work; otherwise (offline, slow, failed) with what the bundled fonts cover.
 * The coin's logo is read from disk (SCREENSHOT_DIR/logos) and embedded: the card never loads a remote image.
 */
async function renderCard(item: CheckReportDTO): Promise<ArrayBuffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const logo = item.kind === 'coin' ? await logoDataUrl(item.logo) : null;
  try {
    return await Promise.race([
      draw(item, false, logo),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('glyph download timed out')), FULL_RENDER_MS);
      }),
    ]);
  } catch (e) {
    console.warn(`[card] ${item.id}: drawing without extra glyphs (${e instanceof Error ? e.message : String(e)})`);
    return draw(item, true, logo);
  } finally {
    clearTimeout(timer);
  }
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = params.id.replace(/\.png$/i, '');
  if (!ID_RE.test(id)) return text(404, "This check doesn't exist or has expired.");

  let r;
  try {
    r = await report(id, serverCall());
  } catch (e) {
    if (isApiError(e, 'not_found')) return text(404, "This check doesn't exist or has expired.");
    return text(503, "Couldn't reach ApeCheck. Try again in a moment.");
  }

  const testing = r.status === 'queued' || r.status === 'running';
  if (!testing && (r.status !== 'done' || r.narScore == null)) return text(409, 'This check stopped before a verdict.');

  let png: ArrayBuffer;
  try {
    // render here rather than streaming, so a failure becomes a clean 500 instead of a cut-off image
    png = await renderCard(r);
  } catch (e) {
    console.error(`[card] couldn't render ${id}:`, e);
    return text(500, "Couldn't draw this card. Try again in a moment.");
  }

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.byteLength),
      // a finished verdict never changes (a re-check gets a new id); a running one does. A private check renders only
      // for its owner (the server render forwards the API cookies): never let a shared cache keep it
      'Cache-Control': r.isPrivate ? 'private, no-store' : testing ? 'no-store' : 'public, max-age=31536000, immutable',
    },
  });
}
