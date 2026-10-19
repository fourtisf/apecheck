import type { TargetKindS } from '@apecheck/core';
import { cssVars } from './css';
import { GlobeIcon, XIcon } from './icons';

export interface AvatarItem {
  kind: TargetKindS;
  /** 0–359, from the DTO */
  hue: number;
  ticker?: string | null;
  name?: string | null;
}

/** First letter for a coin avatar: the ticker's, else the name's (without $/@). */
function letterOf(item: AvatarItem): string {
  const src = (item.ticker || item.name || '').replace(/^[$@]+/, '');
  return (src.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
}

/** avatar(it, size) from the prototype: coins get a hued letter tile, posts an X, sites a globe. */
export function Avatar({ item, size = 30 }: { item: AvatarItem; size?: number }) {
  if (item.kind === 'coin') {
    return (
      <span className="av" style={cssVars({ '--s': `${size}px`, '--h': item.hue })} aria-hidden="true">
        {letterOf(item)}
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
