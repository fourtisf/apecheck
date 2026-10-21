/**
 * Coin logos on the web: the avatar draws our stored copy (never a third-party URL) over the letter tile, and the
 * share card embeds the logo read from disk as a data: URL.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { Avatar } from '@/components/Avatar';
import { VerdictRow } from '@/components/VerdictRow';
import { ShareCardImage } from '@/components/pages/ShareCardImage';
import { logoDataUrl, screenshotDir } from '@/lib/logo-file';
import { report, summary } from './fixtures';

const SHA = 'b'.repeat(64);
const LOGO = `/shots/logos/${SHA}.png`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 2)]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apecheck-web-logos-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('Avatar', () => {
  it('a coin with a stored logo shows it (API origin) over its letter tile', () => {
    const html = renderToStaticMarkup(<Avatar item={{ kind: 'coin', hue: 30, ticker: 'KIMCHI', logo: LOGO }} size={36} />);
    expect(html).toContain('class="av av-logo"');
    expect(html).toMatch(new RegExp(`<img src="https?://[^"]+${LOGO}" alt="" width="36" height="36"`));
    expect(html).toMatch(/referrerpolicy="no-referrer"/i);
    // the letter stays underneath as the fallback
    expect(html).toContain('>K<img');
  });

  it('no logo, or anything but our own /shots/logos path: the letter avatar, no image', () => {
    for (const logo of [null, undefined, 'https://dd.dexscreener.com/ds-data/tokens/solana/x.png', '/shots/logos/x.svg', `/shots/logos/${SHA}.svg`, `//evil.test/shots/logos/${SHA}.png`]) {
      const html = renderToStaticMarkup(<Avatar item={{ kind: 'coin', hue: 30, ticker: 'KIMCHI', logo }} />);
      expect(html, String(logo)).not.toContain('<img');
      expect(html).toContain('>K</span>');
    }
  });

  it('feed rows pass the DTO logo through', () => {
    const html = renderToStaticMarkup(<VerdictRow item={summary({ kind: 'coin', ticker: 'KIMCHI', name: '$KIMCHI', logo: LOGO })} />);
    expect(html).toContain(`${LOGO}"`);
  });
});

describe('share card logo', () => {
  it('reads the stored file as a data: URL (magic bytes checked again)', async () => {
    fs.mkdirSync(path.join(tmp, 'logos'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'logos', `${SHA}.png`), PNG);
    fs.writeFileSync(path.join(tmp, 'logos', `${'c'.repeat(64)}.png`), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(tmp, 'logos', `${'d'.repeat(64)}.webp`), Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'));
    expect(await logoDataUrl(LOGO, tmp)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(await logoDataUrl(`/shots/logos/${'c'.repeat(64)}.png`, tmp)).toBeNull();
    // satori can't draw WebP: the card goes without
    expect(await logoDataUrl(`/shots/logos/${'d'.repeat(64)}.webp`, tmp)).toBeNull();
    expect(await logoDataUrl(`/shots/logos/${'e'.repeat(64)}.png`, tmp)).toBeNull();
    expect(await logoDataUrl('/shots/../../etc/passwd', tmp)).toBeNull();
    expect(await logoDataUrl(null, tmp)).toBeNull();
  });

  it('SCREENSHOT_DIR: absolute as is, relative from the repo root, the core default otherwise', () => {
    expect(screenshotDir({ SCREENSHOT_DIR: '/var/apecheck/shots' })).toBe('/var/apecheck/shots');
    const rel = screenshotDir({}, process.cwd());
    expect(rel.endsWith(path.join('.data', 'shots'))).toBe(true);
    expect(fs.existsSync(path.join(rel, '..', '..', 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('the card draws an embedded logo, never a remote one', () => {
    const it0 = report({ kind: 'coin', ticker: 'KIMCHI', name: '$KIMCHI', hasCoin: true, logo: LOGO });
    const withLogo = renderToStaticMarkup(<ShareCardImage item={it0} logo={`data:image/png;base64,${PNG.toString('base64')}`} />);
    expect(withLogo).toContain('<img src="data:image/png;base64,');
    const remote = renderToStaticMarkup(<ShareCardImage item={it0} logo="https://evil.test/x.png" />);
    expect(remote).not.toContain('<img');
    expect(renderToStaticMarkup(<ShareCardImage item={it0} />)).not.toContain('<img');
  });
});
