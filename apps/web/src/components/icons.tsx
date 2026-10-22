/**
 * The prototype's inline SVGs (XSVG, GLOBE, LOGO, COPY, SEARCH, SUN, MOON, wallet, list/grid) as components.
 * Server-safe: no hooks.
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

/**
 * The ape mark (viewBox 0 0 64 64, design/brand): head and ears with the face cut out as one even-odd path, then the
 * pupils and the check on top. One colour and no mask, so it needs no ids and shows the surface behind it.
 */
export const APE_HEAD =
  'M10.821 26.545A22 22 0 0 1 53.179 26.545A7.5 7.5 0 1 1 52.174 41.274A22 22 0 0 1 11.826 41.274A7.5 7.5 0 1 1 10.821 26.545Z' +
  'M32 24.025A9 9 0 1 0 18.961 36.093A15.5 10 0 1 0 45.039 36.093A9 9 0 1 0 32 24.025Z';
export const APE_PUPILS = [
  [25.3, 28.2],
  [40.3, 28.2],
] as const;
export const APE_CHECK = 'M25.4 42.4l4.5 4 9-7.8';

function ApeMark({ size, color, ...p }: P & { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" {...p}>
      <path d={APE_HEAD} fillRule="evenodd" style={{ fill: color }} />
      {APE_PUPILS.map(([cx, cy]) => (
        <circle key={cx} cx={cx} cy={cy} r="3.6" style={{ fill: color }} />
      ))}
      <path d={APE_CHECK} fill="none" style={{ stroke: color }} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Header brand mark, 30px. */
export function BrandLogo(p: P) {
  return <ApeMark size={30} color="var(--ink)" {...p} />;
}

/** Small brand mark (share card, bot answers), 18px. */
export function Logo(p: P) {
  return <ApeMark size={18} color="var(--ink)" {...p} />;
}

/** The X (Twitter) logo. */
export function TelegramIcon(p: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...p}>
      <path
        fill="currentColor"
        d="M21.43 3.32a1.3 1.3 0 0 0-1.33-.2L2.9 9.88c-.86.34-.84 1.57.03 1.88l4.36 1.53 1.67 5.4c.2.66 1.03.87 1.52.38l2.45-2.43 4.42 3.27c.6.44 1.45.11 1.6-.62l3-14.6a1.3 1.3 0 0 0-.52-1.37zM9.9 14.06l-.53 3.3-1.2-3.9 9.6-6.2-7.87 6.8z"
      />
    </svg>
  );
}

export function XLogoIcon(p: P) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" {...p}>
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
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
