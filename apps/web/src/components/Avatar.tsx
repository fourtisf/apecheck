import { LOGO_PATH_RE, type TargetKindS } from '@apecheck/core';
import { shotUrl } from '@/lib/api';
import { cssVars } from './css';
import { GlobeIcon, XIcon } from './icons';

export interface AvatarItem {
  kind: TargetKindS;
  /** 0–359, from the DTO */
  hue: number;
  ticker?: string | null;
  name?: string | null;
  /** the coin's stored logo, "/shots/logos/<sha256>.<ext>" on the API origin (CheckSummaryDTO.logo) */
  logo?: string | null;
}

/** First letter for a coin avatar: the ticker's, else the name's (without $/@). */
function letterOf(item: AvatarItem): string {
  const src = (item.ticker || item.name || '').replace(/^[$@]+/, '');
  return (src.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
}

/** Our own copy of the logo only: a third-party image URL is never put in front of visitors. */
export function logoSrc(logo: string | null | undefined): string | null {
  return logo && LOGO_PATH_RE.test(logo) && logo.startsWith('/shots/') ? shotUrl(logo) : null;
}

/** avatar(it, size) from the prototype: coins get their logo (else a hued letter tile), posts an X, sites a globe. */
export function Avatar({ item, size = 30 }: { item: AvatarItem; size?: number }) {
  if (item.kind === 'coin') {
    const src = logoSrc(item.logo);
    return (
      <span className={src ? 'av av-logo' : 'av'} style={cssVars({ '--s': `${size}px`, '--h': item.hue })} aria-hidden="true">
        {letterOf(item)}
        {src ? <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null}
      </span>
    );
  }
  if (item.kind === 'post') {
    return (
      <span className="av av-x" style={cssVars({ '--s': `${size}px` })} aria-hidden="true">
        <XIcon />
      </span>
    );
  }
  return (
    <span className="av av-site" style={cssVars({ '--s': `${size}px` })} aria-hidden="true">
      <GlobeIcon />
    </span>
  );
}
