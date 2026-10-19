/**
 * Typed client for the ApeCheck API (apps/api). Every function returns exactly the DTO from
 * packages/core/src/dto.ts; every non-2xx response throws ApiRequestError carrying the API's
 * ApiErrorBody {error, code}.
 *
 * Where it runs decides how it talks to the API:
 * - browser: NEXT_PUBLIC_API_URL with credentials: 'include' (the anonymous credits session is a cookie on the API origin)
 * - server components / route handlers: API_INTERNAL_URL, no cache, short timeout. Pass
 *   `forwardedHeaders()` from '@/lib/server-api' so per-IP limits count the visitor, not the web server.
 */
import type {
  ApiErrorBody,
  AskDTO,
  BotStatsDTO,
  ChainKey,
  CheckReportDTO,
  CoinKey,
  CoinsResponse,
  CreateCheckBody,
  CreateCheckResponse,
  DeployersResponse,
  FeedResponse,
  InsightsDTO,
  LiveResponse,
  MeDTO,
  NarKey,
  NoteDTO,
  TargetKindS,
  ViaS,
} from '@apecheck/core';
import { PUBLIC_API_URL } from './env';

const isServer = typeof window === 'undefined';
/** A server render should never hang on a slow API: it renders the empty/unavailable state instead. */
const SERVER_TIMEOUT_MS = 5000;

export const NETWORK_ERROR = "Couldn't reach ApeCheck. Try again in a moment.";

export class ApiRequestError extends Error {
  /** HTTP status, 0 when the request never got a response */
  readonly status: number;
  /** ApiErrorBody.code: bad_target | no_credits | not_found | rate_limited | ... | network */
  readonly code: string;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code;
    this.body = body;
  }
}

/** True for a fetch the caller cancelled (AbortController), which should be ignored, not shown. */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

export function isApiError(e: unknown, code?: string): e is ApiRequestError {
  return e instanceof ApiRequestError && (code == null || e.code === code);
}

export interface CallOpts {
  signal?: AbortSignal;
  /** extra request headers, e.g. forwardedHeaders() on the server */
  headers?: Record<string, string>;
}

type Query = Record<string, string | number | boolean | null | undefined>;

function apiBase(): string {
  // `typeof window` is a build-time constant in the browser bundle, so the server-only address never ships there
  if (typeof window === 'undefined') return (process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
  return PUBLIC_API_URL;
}

function fallbackBody(status: number): ApiErrorBody {
  if (status === 404) return { code: 'not_found', error: "This check doesn't exist or has expired." };
  if (status === 429) return { code: 'rate_limited', error: 'Too many requests. Wait a minute and try again.' };
  return { code: status >= 500 ? 'internal' : `http_${status}`, error: 'Something went wrong on our side. Try again in a moment.' };
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return !!v && typeof v === 'object' && typeof (v as ApiErrorBody).error === 'string' && typeof (v as ApiErrorBody).code === 'string';
}

async function request<T>(method: 'GET' | 'POST', path: string, query?: Query, body?: unknown, opts: CallOpts = {}): Promise<T> {
  const url = new URL(apiBase() + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (isServer) {
    init.cache = 'no-store';
    init.signal = opts.signal ?? AbortSignal.timeout(SERVER_TIMEOUT_MS);
  } else {
    init.credentials = 'include';
    init.signal = opts.signal;
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (isAbortError(e) && opts.signal?.aborted) throw e;
    throw new ApiRequestError(0, { code: 'network', error: NETWORK_ERROR });
  }

  const text = await res.text().catch(() => '');
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) throw new ApiRequestError(res.status, isErrorBody(json) ? json : fallbackBody(res.status));
  if (json == null) throw new ApiRequestError(res.status, { code: 'bad_response', error: 'Something went wrong on our side. Try again in a moment.' });
  return json as T;
}

const enc = encodeURIComponent;

/* ---------- query shapes (apps/api validates the same values) ---------- */

export type FeedTab = 'latest' | 'checked' | 'real' | 'least' | 'vol' | 'watch';
export type FeedType = 'all' | TargetKindS;

export interface FeedParams {
  tab?: FeedTab;
  type?: FeedType;
  nar?: NarKey | 'any';
  coin?: CoinKey | 'any';
  chain?: ChainKey | 'any';
  q?: string;
  /** opaque, from FeedResponse.nextCursor */
  cursor?: string | null;
  /** 1–100, default 25 */
  limit?: number;
  /** watchlist: short ids; each one selects its target's latest verdict */
  ids?: string[];
  via?: ViaS;
}

export interface CoinsParams {
  tab?: CoinKey | 'all';
  chain?: ChainKey | 'any';
  q?: string;
  /** 1–500, default 200 */
  limit?: number;
}

export interface DeployersParams {
  chain?: ChainKey | 'all';
  sort?: 'real' | 'dead' | 'launched';
  /** 1–500, default 200 */
  limit?: number;
}

/**
 * POST /v1/notes/:id/helpful and POST /v1/watch/:targetId are M3 endpoints (they answer 403/401 today).
 * dto.ts has no shape for their success bodies yet; these are what the web expects.
 */
export interface HelpfulResponse {
  helpful: number;
  mine: boolean;
}
export interface WatchResponse {
  watching: boolean;
}

/* ---------- endpoints ---------- */

/** GET /v1/me — credits left today, tier, token info */
export const me = (o?: CallOpts) => request<MeDTO>('GET', '/v1/me', undefined, undefined, o);

/** POST /v1/checks — uses a credit. 402 no_credits, 400 bad_target. */
export const createCheck = (body: CreateCheckBody, o?: CallOpts) =>
  request<CreateCheckResponse>('POST', '/v1/checks', undefined, body, o);

/** GET /v1/checks/:id — full report (404 not_found) */
export const report = (id: string, o?: CallOpts) => request<CheckReportDTO>('GET', `/v1/checks/${enc(id)}`, undefined, undefined, o);

/** URL for `new EventSource(eventsUrl(id), { withCredentials: true })` (browser only). Close it on the `done` event. */
export const eventsUrl = (id: string) => `${PUBLIC_API_URL}/v1/checks/${enc(id)}/events`;

/** GET /v1/feed */
export const feed = (p: FeedParams = {}, o?: CallOpts) =>
  request<FeedResponse>(
    'GET',
    '/v1/feed',
    {
      tab: p.tab,
      type: p.type,
      nar: p.nar,
      coin: p.coin,
      chain: p.chain,
      q: p.q?.trim(),
      cursor: p.cursor,
      limit: p.limit,
      ids: p.ids ? p.ids.join(',') : undefined,
      via: p.via,
    },
    undefined,
    o,
  );

/** GET /v1/live — up to 8 queued/running public checks, newest first */
export const live = (o?: CallOpts) => request<LiveResponse>('GET', '/v1/live', undefined, undefined, o);

/** GET /v1/insights — hero stats and the three insight cards */
export const insights = (o?: CallOpts) => request<InsightsDTO>('GET', '/v1/insights', undefined, undefined, o);

/** GET /v1/coins */
export const coins = (p: CoinsParams = {}, o?: CallOpts) =>
  request<CoinsResponse>('GET', '/v1/coins', { tab: p.tab, chain: p.chain, q: p.q?.trim(), limit: p.limit }, undefined, o);

/** GET /v1/deployers */
export const deployers = (p: DeployersParams = {}, o?: CallOpts) =>
  request<DeployersResponse>('GET', '/v1/deployers', { chain: p.chain, sort: p.sort, limit: p.limit }, undefined, o);

/** GET /v1/bot/stats — numbers on the /bot page */
export const botStats = (o?: CallOpts) => request<BotStatsDTO>('GET', '/v1/bot/stats', undefined, undefined, o);

/** POST /v1/checks/:id/asks — Pro follow-up (403 pro_required until M3) */
export const asks = (id: string, question: string, o?: CallOpts) =>
  request<AskDTO>('POST', `/v1/checks/${enc(id)}/asks`, undefined, { question }, o);

/** POST /v1/checks/:id/notes — holders only (403 holders_only until M3) */
export const notes = (id: string, text: string, o?: CallOpts) =>
  request<NoteDTO>('POST', `/v1/checks/${enc(id)}/notes`, undefined, { text }, o);

/** POST /v1/notes/:id/helpful — toggles the viewer's "helpful" mark */
export const helpful = (noteId: string, o?: CallOpts) =>
  request<HelpfulResponse>('POST', `/v1/notes/${enc(noteId)}/helpful`, undefined, {}, o);

/** POST /v1/watch/:targetId — signed-in watchlist (401 sign_in_required until M3; M1 keeps the watchlist in localStorage) */
export const watch = (targetId: string, o?: CallOpts) =>
  request<WatchResponse>('POST', `/v1/watch/${enc(targetId)}`, undefined, {}, o);

/**
 * Screenshot paths come back as "/shots/<checkId>/3.jpg" on the API origin; the browser needs the public URL.
 * Absolute http(s) URLs pass through; anything else is refused (null).
 */
export function shotUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!path.startsWith('/')) return null;
  return PUBLIC_API_URL + path;
}

/** Everything above as one object, for `import { api } from '@/lib/api'`. */
export const api = { me, createCheck, report, eventsUrl, feed, live, insights, coins, deployers, botStats, asks, notes, helpful, watch, shotUrl };
