/**
 * Coin logos: the worker downloads one image per coin and stores it under SCREENSHOT_DIR/logos/<sha256>.<ext>
 * (Target.logo = "logos/<sha256>.<ext>", served by the API at /shots/logos/…). Only raster images whose bytes say
 * PNG, JPEG, WebP or GIF are kept; SVG is refused (it can carry scripts when served from our origin).
 */

export type LogoType = 'png' | 'jpeg' | 'webp' | 'gif';

/** download cap */
export const LOGO_MAX_BYTES = 1024 * 1024;

export const LOGO_EXT: Record<LogoType, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };
export const LOGO_MIME: Record<LogoType, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** A stored logo path: "logos/<64 hex>.<ext>" (optionally with the public "/shots/" prefix). */
export const LOGO_PATH_RE = /^(?:\/shots\/)?logos\/([0-9a-f]{64})\.(png|jpg|webp|gif)$/;

/** The image type from its first bytes (magic numbers), or null for anything else (SVG, HTML, truncated…). */
export function sniffImage(buf: Uint8Array): LogoType | null {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}
