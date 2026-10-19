/**
 * Outbound HTTP for every adapter and for page-supplied URLs (undici, no global state).
 *
 * guard:true (user/page URLs): each hop is vetted with the SSRF rules and the connection is pinned to the
 * vetted addresses through an Agent whose lookup only returns those addresses. Redirects are followed by
 * hand (max 5) and every hop is vetted again.
 *
 * OUTBOUND_PROXY: all traffic goes through a ProxyAgent (CONNECT tunnels, also for http:// targets).
 * The proxy resolves names itself, so pinning is then the proxy's job: guarded requests still refuse
 * blocked IP literals, local/metadata names and names that resolve locally to blocked addresses.
 */
import net from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import zlib from 'node:zlib';
import { Agent, ProxyAgent, request as undiciRequest, type Dispatcher } from 'undici';
import type { Env } from '@apecheck/core';
import { SsrfError, vetUrl, normaliseHost, isBlockedIp, type SsrfOptions } from './ssrf';
import type { Http, HttpRequest, HttpResponse } from './types';
import { TimeoutError } from './util';

export const USER_AGENT = 'Mozilla/5.0 (compatible; ApeCheckBot/1.0; +https://apecheck.io/bot)';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

/** Non-2xx from json(). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(`HTTP ${status} from ${safeHost(url)}`);
    this.name = 'HttpError';
  }
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return 'invalid URL';
  }
}

export type HttpEnv = Pick<Env, 'NODE_ENV' | 'OUTBOUND_PROXY' | 'SSRF_ALLOW_HOSTS'>;

export interface HttpOptions {
  /** resolver override (tests) */
  lookup?: SsrfOptions['lookup'];
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function lowerKeys(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/** Agent whose DNS lookup only ever returns the addresses the SSRF check vetted. */
function pinnedAgent(addresses: string[], timeoutMs: number): Agent {
  const entries = addresses.map(address => ({ address, family: net.isIP(address) || 4 }));
  const lookup = (_host: string, opts: { all?: boolean } | number | undefined, cb: (...args: unknown[]) => void) => {
    if (typeof opts === 'object' && opts?.all) cb(null, entries);
    else cb(null, entries[0].address, entries[0].family);
  };
  return new Agent({ connect: { timeout: timeoutMs, lookup: lookup as never }, keepAliveTimeout: 1_000 });
}

/** destroy a body we don't need; the resulting abort error must not surface as an unhandled 'error' */
function discard(stream: Readable): void {
  stream.on('error', () => {});
  stream.destroy();
}

async function readBody(
  body: Readable,
  encoding: string | undefined,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const enc = (encoding ?? '').toLowerCase().trim();
  let stream: Readable = body;
  if (enc === 'gzip' || enc === 'x-gzip' || enc === 'deflate') stream = pipeline(body, zlib.createUnzip(), () => {});
  else if (enc === 'br') stream = pipeline(body, zlib.createBrotliDecompress(), () => {});

  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = maxBytes - size;
      if (buf.length > room) {
        if (room > 0) chunks.push(buf.subarray(0, room));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buf);
      size += buf.length;
    }
  } catch (e) {
    // an empty or cut-off compressed body: keep what was decoded
    const code = String((e as { code?: unknown }).code ?? '');
    if (!code.startsWith('Z_') && code !== 'ERR_STREAM_PREMATURE_CLOSE') throw e;
  } finally {
    if (truncated || !stream.readableEnded) {
      discard(stream);
      if (stream !== body) discard(body);
    }
  }
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), truncated };
}

export function createHttp(env: HttpEnv, options: HttpOptions = {}): Http {
  const production = env.NODE_ENV === 'production';
  const allowHosts = production ? [] : env.SSRF_ALLOW_HOSTS ?? [];
  const proxy: Dispatcher | null = env.OUTBOUND_PROXY ? new ProxyAgent({ uri: env.OUTBOUND_PROXY }) : null;
  const direct: Dispatcher = new Agent({ connect: { timeout: DEFAULT_TIMEOUT_MS } });
  const ssrfOpts: SsrfOptions = { allowHosts, production, lookup: options.lookup, allowUnresolved: !!proxy };

  /** Loopback/allow-listed targets never go through the outbound proxy (it can't reach them). */
  function isLocalTarget(url: URL): boolean {
    const host = normaliseHost(url.hostname);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (host === 'localhost' || (net.isIP(host) && isBlockedIp(host))) return true;
    return allowHosts.some(h => {
      const k = h.trim().toLowerCase();
      return k === host || k === `${host}:${port}` || k === `[${host}]:${port}`;
    });
  }

  async function route(url: URL, guard: boolean, timeoutMs: number): Promise<{ dispatcher: Dispatcher; dispose?: () => Promise<void> }> {
    if (!guard) return { dispatcher: proxy && !isLocalTarget(url) ? proxy : direct };
    const v = await vetUrl(url.href, ssrfOpts);
    if (!v.ok) throw new SsrfError(v.reason ?? 'blocked');
    if (!v.allowListed && proxy) return { dispatcher: proxy };
    if (!v.addresses?.length) return { dispatcher: direct };
    const agent = pinnedAgent(v.addresses, timeoutMs);
    return { dispatcher: agent, dispose: () => agent.close().catch(() => {}) };
  }

  async function request(input: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
    const guard = req.guard === true;
    const follow = req.redirect !== false;
    let method: 'GET' | 'POST' | 'HEAD' = req.method ?? 'GET';
    let body: string | Buffer | undefined = method === 'GET' || method === 'HEAD' ? undefined : req.body;
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: '*/*',
      'accept-encoding': 'gzip, deflate, br',
      ...lowerKeys(req.headers),
    };

    let current: URL;
    try {
      current = new URL(input);
    } catch {
      throw guard ? new SsrfError('invalid URL') : new Error('invalid URL');
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new TimeoutError(current.host, timeoutMs)), timeoutMs);
    try {
      for (let hops = 0; ; hops++) {
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          throw guard ? new SsrfError(`blocked scheme ${current.protocol}`) : new Error(`unsupported scheme ${current.protocol}`);
        }
        const { dispatcher, dispose } = await route(current, guard, timeoutMs);
        try {
          const res = await undiciRequest(current, {
            method,
            headers,
            body,
            dispatcher,
            signal: ac.signal,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
          });
          const resHeaders = flattenHeaders(res.headers as Record<string, string | string[] | undefined>);
          const location = resHeaders.location;
          if (follow && REDIRECTS.has(res.statusCode) && location) {
            discard(res.body);
            if (hops >= MAX_REDIRECTS) throw new Error(`too many redirects from ${new URL(input).host}`);
            const next = new URL(location, current);
            if (next.origin !== current.origin) {
              delete headers.authorization;
              delete headers.cookie;
            }
            if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
              method = 'GET';
              body = undefined;
              delete headers['content-type'];
              delete headers['content-length'];
            }
            current = next;
            continue;
          }
          let text = '';
          let truncated = false;
          if (method === 'HEAD') discard(res.body);
          else ({ text, truncated } = await readBody(res.body as unknown as Readable, resHeaders['content-encoding'], maxBytes));
          return {
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            url: input,
            finalUrl: current.href,
            headers: resHeaders,
            text,
            truncated,
            ms: Date.now() - started,
          };
        } finally {
          await dispose?.();
        }
      }
    } catch (e) {
      if (ac.signal.aborted && ac.signal.reason instanceof TimeoutError) throw ac.signal.reason;
      const refused = /^Proxy response \((\d+)\)/.exec(e instanceof Error ? e.message : '');
      if (refused) throw new Error(`outbound proxy refused ${current.host} (${refused[1]})`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function json<T = unknown>(url: string, req: HttpRequest = {}): Promise<T> {
    const res = await request(url, { ...req, headers: { accept: 'application/json', ...req.headers } });
    if (!res.ok) throw new HttpError(res.status, res.finalUrl, res.text.slice(0, 500), res.headers);
    if (res.truncated) throw new Error(`response from ${safeHost(res.finalUrl)} is larger than ${req.maxBytes ?? DEFAULT_MAX_BYTES} bytes`);
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new Error(`bad JSON from ${safeHost(res.finalUrl)}`);
    }
  }

  return { request, json };
}
