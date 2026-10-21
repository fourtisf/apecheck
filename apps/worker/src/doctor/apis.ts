/**
 * API probes: DexScreener, GitHub and X (the Bearer reads every check makes, and the bot's OAuth 1.0a keys), through
 * the adapters createSources(env) builds. Where an adapter keeps only "HTTP <status>" (it turns errors into
 * null), one raw request with the same headers shows the provider's own reason. Nothing here posts or writes.
 */
import type { Env } from '@apecheck/core';
import {
  captureErrors, signRequest, type DexScreenerSource, type GitHubSource, type Http, type HttpResponse, type XSource,
} from '@apecheck/sources';
import { hostOf } from './redact';
import { errorText, fail, networkRemedy, outcome, pass, warn, type ProbeOutcome } from './result';

/** PEPE on Ethereum: deep liquidity on DexScreener for years */
export const PEPE_ETH = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';

const compactUsd = (n: number | null) =>
  n == null ? '?' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;

/* ---------------- DexScreener ---------------- */

export const DEXSCREENER_REMEDY =
  'no key needed: allow outbound HTTPS from user apecheck to api.dexscreener.com:443, and leave DEXSCREENER_BASE at https://api.dexscreener.com';

/** Both lookups a check makes: by chain (/tokens/v1) and chain-less (/latest/dex/tokens, for contracts found on pages or posts). */
export async function probeDexScreener(deps: { env: Env; dex: Pick<DexScreenerSource, 'token'> }): Promise<ProbeOutcome> {
  const host = hostOf(deps.env.DEXSCREENER_BASE);
  const [byChain, anyChain] = await Promise.all([
    captureErrors(() => deps.dex.token('eth', PEPE_ETH)),
    captureErrors(() => deps.dex.token(null, PEPE_ETH)),
  ]);
  const t = byChain.value;
  if (!t) {
    const msg = byChain.errors[0] ?? 'answered, but without a PEPE pair (is DEXSCREENER_BASE right?)';
    const remedy = /HTTP 429/.test(msg)
      ? 'DexScreener rate-limits this IP (about 300 requests a minute): it clears by itself; fewer checks at once help'
      : networkRemedy(msg, host) ?? DEXSCREENER_REMEDY;
    return fail(`${host}: ${msg}`, remedy);
  }
  if (t.symbol !== 'PEPE' || !(t.priceUsd != null && t.priceUsd > 0)) {
    return fail(`${host}: PEPE mapped as symbol=${t.symbol} price=${t.priceUsd}`, 'DexScreener changed its answer: the mapping in dexscreener.ts needs a look');
  }
  const market = `${host}: PEPE price $${t.priceUsd}, liquidity ${compactUsd(t.liquidityUsd)} on ${t.dex ?? 'unknown dex'}`;
  if (!anyChain.value) {
    return warn(
      `${market}; chain-less lookup /latest/dex/tokens failed: ${anyChain.errors[0] ?? 'no pair'} (contracts found on pages or posts stay unconfirmed)`,
      'a rate limit clears by itself; if it persists, DexScreener retired /latest/dex/tokens (dexscreener.ts token(null, …) needs the new endpoint)',
    );
  }
  return pass(`${market}, chain-less lookup ok`);
}

/* ---------------- GitHub ---------------- */

const GITHUB_API = 'https://api.github.com';
/** a tiny public repo: 3 requests (repo, commits, contributors) */
export const GITHUB_PROBE_REPO = 'https://github.com/octocat/Hello-World';
export const GITHUB_REMEDY =
  'set GITHUB_TOKEN (github.com > Settings > Developer settings > Personal access tokens: fine-grained, public repositories read-only; 5,000 requests/hour)';

interface RateBucket { limit: number; remaining: number; reset: number }

function bucket(raw: unknown): RateBucket | null {
  const b = raw as Partial<RateBucket> | null | undefined;
  return b && typeof b.limit === 'number' && typeof b.remaining === 'number' ? { limit: b.limit, remaining: b.remaining, reset: Number(b.reset) || 0 } : null;
}

const resetText = (epochS: number) => (epochS > 0 ? new Date(epochS * 1000).toISOString().slice(11, 16) + ' UTC' : '?');

/** The budget (GET /rate_limit, which is free) and one repository read through the adapter. */
export async function probeGitHub(deps: { env: Env; http: Http; github: Pick<GitHubSource, 'fromUrl'> }): Promise<ProbeOutcome> {
  const keyed = !!deps.env.GITHUB_TOKEN;
  const who = keyed ? 'GITHUB_TOKEN' : 'anonymous, GITHUB_TOKEN empty';
  // the same headers the adapter sends (github.ts)
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (keyed) headers.authorization = `Bearer ${deps.env.GITHUB_TOKEN}`;
  let rl: HttpResponse;
  try {
    rl = await deps.http.request(`${GITHUB_API}/rate_limit`, { headers, timeoutMs: 10_000 });
  } catch (e) {
    const msg = errorText(e);
    return fail(`api.github.com: ${msg}`, networkRemedy(msg, 'api.github.com') ?? GITHUB_REMEDY);
  }
  if (rl.status === 401) {
    return fail('api.github.com: GITHUB_TOKEN rejected (401 Bad credentials): every GitHub read fails, there is no anonymous fallback', `replace the token, or empty GITHUB_TOKEN; ${GITHUB_REMEDY}`);
  }
  if (!rl.ok) return fail(`api.github.com: /rate_limit answered HTTP ${rl.status}`, keyed ? 'check the token in GitHub settings' : GITHUB_REMEDY);
  let core: RateBucket | null = null;
  let search: RateBucket | null = null;
  try {
    const j = JSON.parse(rl.text) as { resources?: { core?: unknown; search?: unknown } };
    core = bucket(j.resources?.core);
    search = bucket(j.resources?.search);
  } catch {
    core = null;
  }
  const budget = core
    ? `core ${core.remaining}/${core.limit} left (resets ${resetText(core.reset)})${search ? `, search ${search.remaining}/${search.limit}` : ''}`
    : 'budget unknown';

  const { value, errors } = await captureErrors(() => deps.github.fromUrl(GITHUB_PROBE_REPO));
  const repo = value[0];
  const f = { configured: keyed, importance: 'recommended' as const };
  if (!repo) {
    const limited = core?.remaining === 0 || /rate limit/i.test(errors[0] ?? '');
    if (limited) {
      return outcome({ ...f, ok: true, degraded: true }, `api.github.com (${who}): ${budget}; rate limit used up, checks log "GitHub unavailable" until the reset`, keyed ? 'wait for the reset' : GITHUB_REMEDY);
    }
    return fail(`api.github.com (${who}): ${errors[0] ?? 'octocat/Hello-World not read'}; ${budget}`, keyed ? 'check the token in GitHub settings' : GITHUB_REMEDY);
  }
  const low = core != null && core.remaining < 10;
  const detail = `api.github.com (${who}), ${budget}; ${repo.fullName} commits=${repo.commits} contributors=${repo.contributors}${low ? '; budget nearly used up' : ''}`;
  return outcome({ ...f, ok: true, degraded: low }, detail, keyed ? 'the token budget is nearly used up: wait for the reset' : GITHUB_REMEDY);
}

/* ---------------- X reads (Bearer) ---------------- */

const X_API = 'https://api.x.com/2';
export const X_READ_REMEDY =
  'set X_BEARER_TOKEN (developer.x.com > your Project > App > Keys and tokens > Bearer Token; the plan must include v2 post and user lookup)';

/** X's own reason from an error answer: title, reason and detail (never the client id) */
export function xReason(res: Pick<HttpResponse, 'status' | 'text' | 'headers'>): string {
  let reason = '';
  try {
    const j = JSON.parse(res.text) as { title?: unknown; reason?: unknown; detail?: unknown; errors?: { message?: unknown }[] };
    const parts = [j.title, j.reason, j.detail ?? j.errors?.[0]?.message].filter((p): p is string => typeof p === 'string' && !!p);
    reason = parts.join(': ').slice(0, 220);
  } catch {
    reason = '';
  }
  const left = res.headers['x-rate-limit-remaining'];
  const reset = Number(res.headers['x-rate-limit-reset']);
  const limit = left != null ? `, rate limit ${left} left${reset > 0 ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : ''}` : '';
  return `HTTP ${res.status}${reason ? ` ${reason}` : ''}${limit}`;
}

function xRemedy(status: number): string {
  if (status === 401) return 'X_BEARER_TOKEN is wrong or revoked: regenerate the Bearer Token in the developer portal';
  if (status === 403) return 'the App has no v2 read access: attach it to a Project and check the plan or credits in the developer portal';
  if (status === 429) return "the plan's read limit is used up: wait for the reset, or raise the plan";
  return X_READ_REMEDY;
}

/** getUser('X') as the pipeline reads accounts; on failure the same lookup raw, for X's reason. */
export async function probeXRead(deps: { env: Env; http: Http; x: Pick<XSource, 'configured' | 'getUser'> }): Promise<ProbeOutcome> {
  if (!deps.x.configured) {
    return outcome(
      { ok: null, configured: false, importance: 'recommended' },
      'not configured (X_BEARER_TOKEN empty): X post and profile checks cannot read X and end in about 2 s as "partly"; account age is unknown in every check',
      X_READ_REMEDY,
    );
  }
  const { value, errors } = await captureErrors(() => deps.x.getUser('X'));
  if (value?.id) {
    const followers = value.followers != null ? `, ${value.followers.toLocaleString('en-US')} followers` : '';
    return pass(`api.x.com: @${value.handle} (id ${value.id}) read with the Bearer token${followers}`);
  }
  let raw: HttpResponse;
  try {
    raw = await deps.http.request(`${X_API}/users/by/username/X`, {
      headers: { authorization: `Bearer ${deps.env.X_BEARER_TOKEN}`, accept: 'application/json' },
      timeoutMs: 10_000,
    });
  } catch (e) {
    const msg = errors[0] ?? errorText(e);
    return fail(`api.x.com: ${msg}`, networkRemedy(msg, 'api.x.com') ?? X_READ_REMEDY);
  }
  if (raw.ok) return fail(`api.x.com: answered 200, but the adapter read no user (${errors[0] ?? 'no data'})`, 'X changed its user payload: x.ts needs a look');
  return fail(`api.x.com: ${xReason(raw)}`, xRemedy(raw.status));
}

/* ---------------- X bot (OAuth 1.0a user context) ---------------- */

const BOT_KEYS = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'] as const;
export const X_BOT_REMEDY =
  'set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET (App permissions "Read and write", access token generated as the bot account; DEPLOY.md §14)';

/**
 * The bot's keys sign in: a signed GET /2/users/me, the request worker-bot makes to find its own id. Write permission
 * cannot be proven without posting, so it is never tried.
 */
export async function probeXBot(deps: { env: Env; http: Http }): Promise<ProbeOutcome> {
  const { env } = deps;
  const missing = BOT_KEYS.filter(k => !env[k]);
  if (missing.length === BOT_KEYS.length) {
    return outcome({ ok: null, configured: false, importance: 'optional' }, 'not configured: worker-bot idles (no mentions read, no replies)', X_BOT_REMEDY);
  }
  if (missing.length) return fail(`partly configured, ${missing.join(', ')} empty: worker-bot idles`, X_BOT_REMEDY);

  const url = `${X_API}/users/me`;
  const { authorization } = signRequest(
    { consumerKey: env.X_API_KEY!, consumerSecret: env.X_API_SECRET!, token: env.X_ACCESS_TOKEN!, tokenSecret: env.X_ACCESS_SECRET! },
    { method: 'GET', url },
  );
  // a signed request is never replayed to another URL (as x.ts)
  let res: HttpResponse;
  try {
    res = await deps.http.request(url, { headers: { authorization, accept: 'application/json' }, redirect: false, timeoutMs: 10_000 });
  } catch (e) {
    const msg = errorText(e);
    return fail(`api.x.com /2/users/me: ${msg}`, networkRemedy(msg, 'api.x.com') ?? X_BOT_REMEDY);
  }
  if (!res.ok) {
    const remedy =
      res.status === 401
        ? 'the OAuth 1.0a keys are rejected: regenerate the access token as the bot account, and check the VPS clock (timedatectl: "System clock synchronized: yes")'
        : res.status === 403
          ? 'the App or Project lacks access: check it in the developer portal'
          : X_BOT_REMEDY;
    return fail(`api.x.com /2/users/me: ${xReason(res)}`, remedy);
  }
  let id = '';
  let username = '';
  try {
    const d = (JSON.parse(res.text) as { data?: { id?: unknown; username?: unknown } }).data;
    id = typeof d?.id === 'string' ? d.id : '';
    username = typeof d?.username === 'string' ? d.username : '';
  } catch {
    id = '';
  }
  if (!id) return fail('api.x.com /2/users/me: answered 200 without a user id', 'X changed its payload: x.ts needs a look');

  const fixed = env.X_BOT_USER_ID?.trim();
  if (fixed && fixed !== id) {
    return fail(`the keys sign in as @${username} (id ${id}), but X_BOT_USER_ID=${fixed}: the bot would read another account's mentions`, `set X_BOT_USER_ID=${id}, or use the bot account's access token`);
  }
  const notes: string[] = [];
  const fixes: string[] = [];
  if (!fixed) {
    notes.push('X_BOT_USER_ID empty');
    fixes.push(`set X_BOT_USER_ID=${id}`);
  }
  if (username && username.toLowerCase() !== env.X_BOT_HANDLE.toLowerCase()) {
    notes.push(`X_BOT_HANDLE=${env.X_BOT_HANDLE} differs`);
    fixes.push(`set X_BOT_HANDLE=${username}`);
  }
  if (!env.X_BEARER_TOKEN) {
    notes.push('X_BEARER_TOKEN empty: the bot cannot read parent posts or author age');
    fixes.push('set X_BEARER_TOKEN too');
  }
  const detail = `api.x.com: keys sign in as @${username} (id ${id}); write permission cannot be checked without posting${notes.length ? `; ${notes.join('; ')}` : ''}`;
  return outcome({ ok: true, configured: true, importance: 'optional', degraded: notes.length > 0 }, detail, fixes.join('; '));
}
