/** Formatting helpers, identical output to the prototype's helpers. */

export const esc = (s: unknown) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** 0x12ab…cdef style shortening for addresses longer than 14 chars. */
export const short = (a: string | null | undefined) => (a && a.length > 14 ? a.slice(0, 5) + '…' + a.slice(-4) : a ?? '');
export const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s ?? '');

/** seconds → "m:ss" */
export const fmtT = (s: number) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
/** seconds → "2m 41s" */
export const fmtDur = (s: number) => { s = Math.round(s); return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };

export const fmtUsd = (n: number) =>
  n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  : n >= 1e3 ? '$' + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K'
  : '$' + Math.round(n);

/** +6.1% / −42% (uses the real minus sign like the prototype) */
export const fmtPct = (p: number) => (p >= 0 ? '+' : '−') + (Math.abs(p) >= 10 ? Math.round(Math.abs(p)) : Math.abs(p).toFixed(1)) + '%';

/** Compact age: "now", "5m", "3h", "2d" */
export const ago = (ts: number | string | Date, now: number = Date.now()) => {
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const m = Math.max(0, Math.floor((now - t) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
};
export const agoLong = (ts: number | string | Date, now?: number) => { const a = ago(ts, now); return a === 'now' ? 'just now' : a + ' ago'; };

/**
 * Account / wallet age the way the prototype writes it:
 * ≥1 year → "2y 3m", ≥1 month → "7 months", else "12 days".
 */
export function fmtAge(since: string | number | Date | null | undefined, now: number = Date.now()): string | null {
  if (since == null) return null;
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.max(0, Math.floor((now - t) / 86400000));
  if (days >= 365) { const y = Math.floor(days / 365); const m = Math.floor((days % 365) / 30.44); return m ? `${y}y ${m}m` : `${y}y`; }
  if (days >= 30) { const m = Math.floor(days / 30.44); return `${m} month${m === 1 ? '' : 's'}`; }
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** 1234 → "1,234"; 12345 → "12.3k" (follower counts like the prototype) */
export function fmtCount(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return n.toLocaleString('en-US');
}

/** Token amounts in notes ("holds 3.1M $APECHECK") */
export function fmtAmount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

/** FNV-1a, same as the prototype's hash(); used for stable avatar hues. */
export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const hueOf = (key: string) => hash(key) % 360;

/** "since check" percentage from prices */
export function sincePct(priceAtCheck: number | null | undefined, priceNow: number | null | undefined): number | null {
  if (!priceAtCheck || priceNow == null || !Number.isFinite(priceAtCheck) || priceAtCheck <= 0) return null;
  return (priceNow / priceAtCheck - 1) * 100;
}
