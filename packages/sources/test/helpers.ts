import { readFileSync } from 'node:fs';
import { EnvZ, type Env } from '@apecheck/core';
import { HttpError } from '../src/http';
import type { Http, HttpRequest, HttpResponse } from '../src/types';

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

/** Env with defaults; empty strings count as unset, same as production parsing. */
export function testEnv(vars: Record<string, string> = {}): Env {
  return EnvZ.parse({ NODE_ENV: 'test', ...vars });
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}
export type Handler = (url: URL, req: HttpRequest, body: unknown) => FakeReply | Promise<FakeReply> | undefined;

export interface FakeHttp extends Http {
  calls: { url: string; req: HttpRequest; body: unknown }[];
}

/**
 * Http that answers from handlers (first one returning a reply wins) and records every call.
 * Unmatched requests get a 599 so a missing route is obvious in the test output.
 */
export function fakeHttp(...handlers: Handler[]): FakeHttp {
  const calls: FakeHttp['calls'] = [];
  async function request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    let body: unknown = req.body;
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body);
      } catch {
        body = req.body;
      }
    }
    calls.push({ url, req, body });
    const u = new URL(url);
    let reply: FakeReply | undefined;
    for (const h of handlers) {
      reply = await h(u, req, body);
      if (reply) break;
    }
    reply ??= { status: 599, text: `no fake route for ${req.method ?? 'GET'} ${url}` };
    const status = reply.status ?? 200;
    const text = reply.text ?? (reply.json !== undefined ? JSON.stringify(reply.json) : '');
    return { status, ok: status >= 200 && status < 300, url, finalUrl: url, headers: reply.headers ?? {}, text, truncated: false, ms: 1 };
  }
  async function json<T>(url: string, req: HttpRequest = {}): Promise<T> {
    const res = await request(url, req);
    if (!res.ok) throw new HttpError(res.status, res.finalUrl, res.text, res.headers);
    return JSON.parse(res.text) as T;
  }
  return { request, json, calls };
}

/** JSON-RPC handler: answers by method name. */
export function rpcHandler(host: string, byMethod: Record<string, (params: unknown[]) => unknown>): Handler {
  return (url, _req, body) => {
    if (url.host !== host) return undefined;
    const b = body as { method: string; params: unknown[]; id: number };
    const fn = byMethod[b.method];
    if (!fn) return { json: { jsonrpc: '2.0', id: b.id, error: { code: -32601, message: `method ${b.method} not in fake` } } };
    const out = fn(b.params);
    if (out && typeof out === 'object' && 'error' in (out as object)) return { json: { jsonrpc: '2.0', id: b.id, ...(out as object) } };
    return { json: { jsonrpc: '2.0', id: b.id, result: out } };
  };
}

/* ---- ABI encoding helpers for EVM fixtures ---- */
export const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
export const encUint = (n: bigint | number) => '0x' + word(BigInt(n).toString(16));
export const encAddress = (a: string) => '0x' + word(a.toLowerCase());
export function encString(s: string): string {
  const bytes = Buffer.from(s, 'utf8').toString('hex');
  const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64 || 64, '0');
  return '0x' + word('20') + word(Buffer.byteLength(s).toString(16)) + padded;
}
export function encBytes32(s: string): string {
  return '0x' + Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0');
}
