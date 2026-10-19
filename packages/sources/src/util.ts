import { AsyncLocalStorage } from 'node:async_hooks';

/** Short, log-friendly message for any thrown value. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const cause = (e as { cause?: unknown }).cause;
    const base = e.message || (typeof code === 'string' ? code : e.name);
    if (cause instanceof Error && cause.message && !base.includes(cause.message)) return `${base} (${cause.message})`;
    return base;
  }
  return String(e);
}

/**
 * Per-call error collection. Adapter methods swallow errors (they resolve null/[]), so coinFacts and the
 * worker read the reasons from the scope they run in instead of a shared `lastError`, which would mix
 * errors of checks running concurrently.
 */
const scope = new AsyncLocalStorage<string[]>();

export function reportError(message: string): void {
  scope.getStore()?.push(message);
}

export async function captureErrors<T>(fn: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
  const errors: string[] = [];
  const value = await scope.run(errors, fn);
  return { value, errors };
}

/** Holds an adapter's `lastError` and mirrors each failure into the current captureErrors scope. */
export class ErrorState {
  lastError: string | null = null;
  constructor(private readonly prefix: string) {}
  fail(op: string, e: unknown): void {
    const msg = `${this.prefix}.${op}: ${errMsg(e)}`;
    this.lastError = msg;
    reportError(msg);
  }
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: timeout after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new TimeoutError(label, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Finite number from a number or numeric string, else null. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Raw integer token amount → whole tokens (exact integer part, the fraction as a float). */
export function toUnits(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

export function isoFromMs(ms: unknown): string | null {
  const n = num(ms);
  if (n == null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoFromSeconds(s: unknown): string | null {
  const n = num(s);
  return n == null ? null : isoFromMs(n * 1000);
}

export const uniq = <T>(a: T[]): T[] => [...new Set(a)];

export const RE_EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const RE_SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const RE_TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
