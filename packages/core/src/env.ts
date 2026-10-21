/**
 * Environment for the Node processes (api, worker). Every variable from .env.example,
 * parsed once with defaults. Empty strings count as "not set".
 * The web app only reads NEXT_PUBLIC_* and the internal API URL (see apps/web).
 */
import { z } from 'zod';

const str = (def: string) => z.string().optional().transform((v): string => (v == null || v.trim() === '' ? def : v.trim()));
const optStr = () => z.string().optional().transform((v): string | undefined => (v == null || v.trim() === '' ? undefined : v.trim()));
const int = (def: number) => z.string().optional().transform(v => { const n = v == null || v.trim() === '' ? def : Number.parseInt(v, 10); return Number.isFinite(n) ? n : def; });
const bool = (def: boolean) => z.string().optional().transform(v => (v == null || v.trim() === '' ? def : /^(1|true|yes|on)$/i.test(v.trim())));
const list = () => z.string().optional().transform(v => (v ?? '').split(',').map(s => s.trim()).filter(Boolean));

export const EnvZ = z.object({
  NODE_ENV: str('development'),
  APP_URL: str('http://localhost:3000'),
  API_URL: str('http://localhost:4000'),
  /** how the web server and workers reach the API / web internally */
  API_INTERNAL_URL: str('http://127.0.0.1:4000'),
  WEB_INTERNAL_URL: str('http://127.0.0.1:3000'),
  API_PORT: int(4000),
  API_HOST: str('127.0.0.1'),
  SESSION_SECRET: str('dev-only-insecure-secret-change-me-dev-only-insecure-secret-change'),
  CORS_ORIGINS: list(),
  LOG_LEVEL: str('info'),

  DATABASE_URL: str('postgresql://apecheck:apecheck@localhost:5432/apecheck'),
  REDIS_URL: str('redis://localhost:6379'),

  ANTHROPIC_API_KEY: optStr(),
  /** optional override of the Anthropic API base URL (defaults to the public API) */
  AI_BASE_URL: optStr(),
  AI_MODEL_JUDGE: str('claude-sonnet-5-5'),
  AI_MODEL_FAST: str('claude-haiku-5-5'),
  CHECK_BUDGET_SECONDS: int(180),
  CHECK_MAX_AGENT_ACTIONS: int(6),
  MAX_CONCURRENT_BROWSERS: int(2),
  CACHE_HOURS: int(6),
  SCREENSHOT_DIR: str('./.data/shots'),
  /** outbound proxy for Chromium and server-side fetches (optional; e.g. a sandbox egress proxy) */
  OUTBOUND_PROXY: optStr(),
  /**
   * DEV/TEST ONLY: host[:port] list the SSRF guard lets through even though they resolve to
   * private/loopback addresses (local fixture sites for the e2e test). Ignored when NODE_ENV=production.
   */
  SSRF_ALLOW_HOSTS: list(),
  /**
   * The isolated browser host (deploy/browser, DEPLOY.md §6): ws://127.0.0.1:9223/<BROWSER_WS_PATH>. When set,
   * worker-checks never starts Chromium itself but connects there. Required when NODE_ENV=production; empty in
   * dev/test, where Chromium runs in-process.
   */
  BROWSER_WS_ENDPOINT: optStr(),
  /** with a remote browser: the fixed port of worker-checks' SSRF guard proxy, the only port the browser user may reach (0 = any, tests) */
  BROWSER_GUARD_PORT: int(9224),

  X_API_KEY: optStr(),
  X_API_SECRET: optStr(),
  X_ACCESS_TOKEN: optStr(),
  X_ACCESS_SECRET: optStr(),
  X_BEARER_TOKEN: optStr(),
  X_BOT_USER_ID: optStr(),
  X_BOT_HANDLE: str('ApeCheckBot'),
  X_OAUTH2_CLIENT_ID: optStr(),
  X_OAUTH2_CLIENT_SECRET: optStr(),
  BOT_POLL_SECONDS: int(20),
  BOT_USER_HOURLY: int(3),
  BOT_PRO_USER_HOURLY: int(20),
  BOT_HOURLY_CAP: int(200),
  BOT_INCLUDE_LINK: bool(false),

  HELIUS_API_KEY: optStr(),
  /** one key for Ethereum, Base and Arbitrum RPCs (RPC_ETH / RPC_BASE / RPC_ARB override it) */
  ALCHEMY_API_KEY: optStr(),
  ETHERSCAN_API_KEY: optStr(),
  TRONGRID_API_KEY: optStr(),
  RPC_SOLANA: optStr(),
  RPC_ETH: optStr(),
  RPC_BASE: optStr(),
  RPC_BSC: optStr(),
  RPC_ARB: optStr(),
  RPC_ROBINHOOD: optStr(),
  DEXSCREENER_BASE: str('https://api.dexscreener.com'),

  GITHUB_TOKEN: optStr(),

  FREE_CHECKS_PER_DAY: int(5),
  TOKEN_CHAIN: str('sol'),
  TOKEN_ADDRESS: optStr(),
  PRO_MIN_HOLD: int(250000),
  MAX_MIN_HOLD: int(2500000),
  PRO_CHECKS_PER_DAY: int(30),
  MAX_CHECKS_PER_DAY: int(200),

  /** M3: share the session/sid cookies with the web origin (e.g. ".apecheck.io") so server-rendered pages see the viewer */
  COOKIE_DOMAIN: optStr(),
  /**
   * M3: tier overrides for team/test wallets before (or besides) token holding: "address:pro,address:max".
   * Applied on sign-in; never lowers a tier computed from holdings.
   */
  TIER_OVERRIDES: list(),
  /** M3: follow-up questions per signed-in user per hour */
  ASKS_PER_HOUR: int(20),
  /** M3: community notes per user per day */
  NOTES_PER_DAY: int(10),
  /** M3: how often watched targets are fingerprinted for changes */
  WATCH_RECHECK_HOURS: int(6),
  /** M3: automatic re-checks (Max watchlists) per user per day */
  MAX_AUTO_RECHECKS_PER_DAY: int(20),

  /** M4: API keys per Max user, requests per key per minute, webhooks per user */
  API_KEYS_PER_USER: int(5),
  API_KEY_RATE_PER_MIN: int(60),
  WEBHOOKS_PER_USER: int(5),
  /** M4: the MCP server (Streamable HTTP) is served by the API at /mcp; mcp.apecheck.io proxies to it */
  MCP_ENABLED: bool(true),
});

export type Env = z.infer<typeof EnvZ>;

let cached: Env | null = null;

/** Parse process.env (call after dotenv has loaded the repo-root .env). */
export function getEnv(source: Record<string, string | undefined> = process.env): Env {
  if (source === process.env && cached) return cached;
  const env = EnvZ.parse(source);
  if (source === process.env) cached = env;
  return env;
}
/** For tests. */
export function resetEnvCache() { cached = null; }

export const isProd = (env: Env) => env.NODE_ENV === 'production';
export const tokenLive = (env: Env) => !!env.TOKEN_ADDRESS;
