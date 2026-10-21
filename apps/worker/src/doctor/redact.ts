/**
 * Nothing the doctor prints may carry a secret: API keys, tokens, the database and Redis passwords, the browser
 * host's endpoint path (its shared secret) or a provider key inside an RPC URL (often /v2/<key> or ?api-key=<key>).
 * Probes report hosts only (hostOf); the Redactor is the last pass over every detail and remedy before printing.
 */
import type { Env } from '@apecheck/core';

export const REDACTED = '<redacted>';
/** what the browser endpoint's path is shown as (browser.ts connectRemote uses the same label) */
export const WS_PATH_LABEL = '/<BROWSER_WS_PATH>';

/** values that are secrets as a whole */
const SECRET_VARS = [
  'SESSION_SECRET', 'ANTHROPIC_API_KEY', 'X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'X_BEARER_TOKEN',
  'X_OAUTH2_CLIENT_SECRET', 'HELIUS_API_KEY', 'ALCHEMY_API_KEY', 'ETHERSCAN_API_KEY', 'TRONGRID_API_KEY', 'FOURTIS_API_KEY', 'GITHUB_TOKEN',
] as const;
/** URLs whose user info, path or query may carry a key (provider RPC URLs, the Fourtis base, a proxy with credentials) */
const KEYED_URL_VARS = ['RPC_SOLANA', 'RPC_ETH', 'RPC_BASE', 'RPC_BSC', 'RPC_ARB', 'RPC_ROBINHOOD', 'FOURTIS_API_URL', 'AI_BASE_URL', 'OUTBOUND_PROXY'] as const;
/** URLs whose password is a secret (their path is a database number or name) */
const PASSWORD_URL_VARS = ['DATABASE_URL', 'REDIS_URL'] as const;

/** shorter values are not redacted: replacing them would mangle ordinary words without protecting anything */
const MIN_SECRET_LENGTH = 6;

/** key-looking query parameters, Bearer tokens and URL passwords, whatever their source */
const GENERIC: [RegExp, string][] = [
  [/([?&](?:api[-_]?key|apikey|key|token|access_token|auth|secret)=)[^&\s#'"]+/gi, `$1${REDACTED}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]*:)[^\s/@'"]+@/gi, `$1${REDACTED}@`],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=%-]{16,}/g, `$1${REDACTED}`],
];

function parseUrl(v: string | undefined): URL | null {
  if (!v) return null;
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

export class Redactor {
  /** [secret, replacement], longest first so a whole URL goes before its path */
  private readonly pairs: [string, string][];

  constructor(env: Partial<Record<keyof Env, unknown>>) {
    const pairs = new Map<string, string>();
    const add = (v: unknown, label = REDACTED) => {
      if (typeof v !== 'string' || v.length < MIN_SECRET_LENGTH) return;
      pairs.set(v, label);
      const encoded = encodeURIComponent(v);
      if (encoded !== v) pairs.set(encoded, label);
      // a value with a line break or NUL (bad quoting in .env) can reach a message split at that character
      for (const piece of v.split(/[\r\n\0]/)) if (piece !== v && piece.length >= MIN_SECRET_LENGTH) pairs.set(piece, label);
    };
    const addPassword = (u: URL) => {
      const password = decodeURIComponent(u.password);
      // a dev placeholder (apecheck:apecheck@…/apecheck) is the user or database name too: redacting it everywhere
      // would blank the app's own name in every line; inside a URL the password pattern below still hides it
      const words = [decodeURIComponent(u.username), ...u.hostname.split('.'), ...u.pathname.split('/')];
      if (!password || words.includes(password)) return;
      add(u.password);
      add(password);
    };
    for (const k of SECRET_VARS) add(env[k]);
    for (const k of KEYED_URL_VARS) {
      const raw = env[k];
      const u = parseUrl(typeof raw === 'string' ? raw : undefined);
      if (!u) {
        add(raw);
        continue;
      }
      add(raw);
      addPassword(u);
      if (u.pathname.length > 1) add(u.pathname);
      if (u.search.length > 1) add(u.search);
    }
    for (const k of PASSWORD_URL_VARS) {
      const raw = env[k];
      const u = parseUrl(typeof raw === 'string' ? raw : undefined);
      if (u) addPassword(u);
    }
    const ws = parseUrl(typeof env.BROWSER_WS_ENDPOINT === 'string' ? env.BROWSER_WS_ENDPOINT : undefined);
    if (ws && ws.pathname.length > 1) {
      add(ws.pathname, WS_PATH_LABEL);
      add(ws.pathname.slice(1), WS_PATH_LABEL.slice(1));
    }
    this.pairs = [...pairs].sort((a, b) => b[0].length - a[0].length);
  }

  text(s: string): string {
    let out = s;
    for (const [secret, label] of this.pairs) out = out.split(secret).join(label);
    for (const [re, to] of GENERIC) out = out.replace(re, to);
    return out;
  }
}

/** host[:port] of a URL, never its path or query (where provider keys live) */
export function hostOf(url: string | null | undefined): string {
  if (!url) return '-';
  try {
    return new URL(url).host || '(no host)';
  } catch {
    return '(invalid URL)';
  }
}

/** host:port/db of a Postgres or Redis URL, without user or password */
export function dbLabel(url: string, defaultPort: number): string {
  try {
    const u = new URL(url);
    const db = u.pathname.length > 1 ? u.pathname : '';
    return `${u.hostname}:${u.port || defaultPort}${db}`;
  } catch {
    return '(invalid URL)';
  }
}

/** ws://host:port/<BROWSER_WS_PATH>: the endpoint with its secret path replaced */
export function wsLabel(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 ? WS_PATH_LABEL : '/'}`;
  } catch {
    return '(invalid URL)';
  }
}
