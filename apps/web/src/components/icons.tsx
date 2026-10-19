/**
 * The prototype's inline SVGs (XSVG, GLOBE, LOGO, COPY, SEARCH, SUN, MOON, wallet, list/grid) as components.
 * Server-safe: no hooks.
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

/** Header brand mark, 28px. */
export function BrandLogo(p: P) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" {...p}>
      <rect x="3.5" y="3.5" width="21" height="21" rx="6" transform="rotate(-8 14 14)" style={{ fill: 'var(--ink)' }} />
      <path d="M8.6 13.8l3.9 4.3 7-8.8" fill="none" style={{ stroke: 'var(--bg)' }} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Small brand mark (share card, bot answers), 18px. */
export function Logo(p: P) {
  return (
    <svg width="18" height="18" viewBox="0 0 28 28" aria-hidden="true" {...p}>
      <rect x="3.5" y="3.5" width="21" height="21" rx="6" transform="rotate(-8 14 14)" style={{ fill: 'var(--ink)' }} />
      <path d="M8.6 13.8l3.9 4.3 7-8.8" fill="none" style={{ stroke: 'var(--bg)' }} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function XIcon(p: P) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
      <path d="M3 2.5l10 11M13 2.5l-10 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function GlobeIcon(p: P) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" {...p}>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.8 8h12.4M8 1.8c2 2 2 10.4 0 12.4M8 1.8c-2 2-2 10.4 0 12.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function CopyIcon(p: P) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" {...p}>
      <rect x="5" y="5" width="9" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 3.5V3a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 2 3v6.5A1.5 1.5 0 0 0 3.5 11H4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function SearchIcon(p: P) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" {...p}>
      <circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function SunIcon(p: P) {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true" {...p}>
      <circle cx="9" cy="9" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M9 1.8v1.8M9 14.4v1.8M1.8 9h1.8M14.4 9h1.8M3.9 3.9l1.3 1.3M12.8 12.8l1.3 1.3M3.9 14.1l1.3-1.3M12.8 5.2l1.3-1.3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoonIcon(p: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" {...p}>
      <path d="M15 11.2A6.5 6.5 0 0 1 6.8 3a6.5 6.5 0 1 0 8.2 8.2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function WalletIcon(p: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...p}>
      <rect x="1.5" y="3.5" width="13" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 8.5h4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function ListIcon(p: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function GridIcon(p: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" {...p}>
      <rect x="2" y="2" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
