/**
 * Public URLs. NEXT_PUBLIC_* values are inlined at build time (next.config.mjs fills them from
 * API_URL / APP_URL in the repo-root .env when they are not set), so this file is safe in the browser.
 */
const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** The API as the browser reaches it, e.g. https://api.apecheck.io */
export const PUBLIC_API_URL = trimSlash(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000');

/** The site itself, e.g. https://apecheck.io */
export const APP_URL = trimSlash(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');

/** "apecheck.io" — used in copy like "apecheck.io/c/abc123" */
export const APP_HOST = (() => {
  try {
    return new URL(APP_URL).host;
  } catch {
    return 'apecheck.io';
  }
})();

export const reportPath = (id: string) => `/c/${encodeURIComponent(id)}`;
