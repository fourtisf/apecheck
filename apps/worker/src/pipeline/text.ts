/** Small wording helpers for step sentences (the prototype's plain voice). */

export function quote(label: string, max = 40): string {
  const t = label.replace(/\s+/g, ' ').replace(/['‘’]/g, '’').trim();
  return `'${t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t}'`;
}

/** "app.orbit.xyz/swap" */
export function shortUrl(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, '');
    const p = (u.pathname + (u.hash.startsWith('#/') ? u.hash : '')).replace(/\/+$/, '');
    const s = host + (p === '/' ? '' : p);
    return s.length > 60 ? s.slice(0, 59) + '…' : s;
  } catch {
    return url.slice(0, 60);
  }
}

/** "today", "yesterday", "3 days ago", "5 months ago", "2 years ago" */
export function sinceText(d: Date | string | null | undefined, now = Date.now()): string | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor(Math.max(0, now - t) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30.44)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function secs(ms: number): string {
  return Math.max(0.1, ms / 1000).toFixed(1) + 's';
}

/** Plain words for Playwright / network errors. */
export function netErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = /net::(ERR_[A-Z_]+)/.exec(msg)?.[1];
  const map: Record<string, string> = {
    ERR_CONNECTION_REFUSED: 'connection refused',
    ERR_NAME_NOT_RESOLVED: 'the domain does not resolve',
    ERR_NAME_RESOLUTION_FAILED: 'the domain does not resolve',
    ERR_TIMED_OUT: 'timed out',
    ERR_CONNECTION_TIMED_OUT: 'timed out',
    ERR_BLOCKED_BY_CLIENT: 'blocked by the SSRF guard',
    ERR_TUNNEL_CONNECTION_FAILED: 'could not connect',
    ERR_PROXY_CONNECTION_FAILED: 'could not connect',
    ERR_CONNECTION_RESET: 'connection reset',
    ERR_CONNECTION_CLOSED: 'connection closed',
    ERR_EMPTY_RESPONSE: 'empty response',
    ERR_SSL_PROTOCOL_ERROR: 'TLS error',
    ERR_ABORTED: 'navigation aborted',
    ERR_TOO_MANY_REDIRECTS: 'too many redirects',
    ERR_ADDRESS_UNREACHABLE: 'address unreachable',
  };
  if (code) return map[code] ?? (code.startsWith('ERR_CERT') ? 'bad TLS certificate' : code.toLowerCase().replace(/^err_/, '').replace(/_/g, ' '));
  if (/Timeout \d+ms exceeded|timed out/i.test(msg)) return 'timed out';
  if (/Target (page, context or browser )?(has been )?closed|browser has been closed/i.test(msg)) return 'the browser closed';
  return msg.split('\n')[0].slice(0, 120);
}
