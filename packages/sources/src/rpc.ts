/** JSON-RPC 2.0 over Http, shared by the EVM and Solana adapters. */
import { HttpError } from './http';
import type { Http } from './types';

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly data: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function toRpcError(env: RpcEnvelope['error']): RpcError {
  return new RpcError(env?.message ?? 'RPC error', typeof env?.code === 'number' ? env.code : null, env?.data);
}

let nextId = 1;

/**
 * Call one JSON-RPC method. `allowed` is the adapter's read-only method list: anything else (in
 * particular eth_sendTransaction / eth_sendRawTransaction / sendTransaction) is refused before a request is built.
 */
export async function jsonRpc(
  http: Http,
  url: string,
  method: string,
  params: unknown[],
  allowed: ReadonlySet<string>,
  opts: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {},
): Promise<unknown> {
  if (!allowed.has(method)) throw new Error(`RPC method ${method} is not allowed (read-only adapter)`);
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
  let res: RpcEnvelope;
  try {
    res = await http.json<RpcEnvelope>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body,
      timeoutMs: opts.timeoutMs ?? 8_000,
      maxBytes: opts.maxBytes ?? 8 * 1024 * 1024,
    });
  } catch (e) {
    // some nodes answer reverts with a non-2xx status and a JSON-RPC error body
    if (e instanceof HttpError) {
      try {
        const parsed = JSON.parse(e.body) as RpcEnvelope;
        if (parsed?.error) throw toRpcError(parsed.error);
      } catch (inner) {
        if (inner instanceof RpcError) throw inner;
      }
    }
    throw e;
  }
  if (!res || typeof res !== 'object') throw new Error('RPC answered with a non-object');
  if (res.error) throw toRpcError(res.error);
  if (!('result' in res)) throw new Error('RPC response without result');
  return res.result;
}
