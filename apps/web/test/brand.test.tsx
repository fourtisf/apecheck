/**
 * Brand bits without a browser: the $APECHECK "CA" pill ("Coming soon" until TOKEN_ADDRESS is set, then the address,
 * copied on click), the footer's X link, and the ape mark drawn without ids (it appears several times on a page).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MeDTO } from '@apecheck/core';
import { Footer } from '@/components/Footer';
import { BrandLogo, Logo } from '@/components/icons';
import { MeProvider } from '@/components/Me';
import { TokenCA, caClick } from '@/components/TokenCA';

const CA = 'APEcheckMint1111111111111111111111111111111';

function me(o: Partial<MeDTO> = {}): MeDTO {
  return {
    credits: 5,
    max: 5,
    resetsAt: new Date().toISOString(),
    tier: 'free',
    tokenLive: false,
    tokenAddress: null,
    proMinHold: null,
    maxMinHold: null,
    user: null,
    ...o,
  };
}
const html = (node: React.ReactElement, m: MeDTO | null) => renderToStaticMarkup(<MeProvider initial={m}>{node}</MeProvider>);

describe('CA pill', () => {
  it('says "Coming soon" before launch, and before the viewer is known', () => {
    for (const m of [me(), null]) {
      const out = html(<TokenCA />, m);
      expect(out).toContain('>CA<');
      expect(out).toContain('Coming soon');
      expect(out).toContain('aria-label="$APECHECK contract address: coming soon"');
    }
  });

  it('shows the full address once the token is live', () => {
    const out = html(<TokenCA />, me({ tokenLive: true, tokenAddress: CA }));
    expect(out).toContain(`>${CA}<`);
    expect(out).toContain(`aria-label="Copy the $APECHECK contract address ${CA}"`);
    expect(out).not.toContain('Coming soon');
  });

  it('copies the address on click, or explains that it is not out yet', () => {
    expect(caClick(CA)).toEqual({ copy: CA, toast: 'Contract address copied' });
    expect(caClick(null)).toEqual({ copy: null, toast: expect.stringContaining('coming soon') });
  });
});

describe('footer', () => {
  it('links to ApeCheck on X and Telegram in a new tab and carries the CA pill', () => {
    const out = html(<Footer />, me());
    expect(out).toContain('href="https://x.com/ApeCheckBot" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('href="https://t.me/APECHECK" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('class="ca-pill"');
  });
});

describe('ape mark', () => {
  it('is one even-odd path plus pupils and check, with no ids to collide when it repeats', () => {
    for (const out of [renderToStaticMarkup(<BrandLogo />), renderToStaticMarkup(<Logo />)]) {
      expect(out).toContain('fill-rule="evenodd"');
      expect(out.match(/<circle /g)).toHaveLength(2);
      expect(out).not.toMatch(/\sid=|mask|url\(#/);
    }
  });
});
