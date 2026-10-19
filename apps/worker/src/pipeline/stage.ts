/**
 * Stage runner: each stage gets its own timeout, capped by the overall check budget. A stage that times
 * out or throws is recorded in `degraded` and the run carries on with whatever the stage left behind.
 */
import type { CheckRun } from './context';

export type StageName = 'resolve' | 'open' | 'explore' | 'docs' | 'claims' | 'evidence' | 'judge';

export class StageTimeout extends Error {
  constructor(readonly stage: string) {
    super(`${stage} timed out`);
    this.name = 'StageTimeout';
  }
}

export type StageResult<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'skipped' | 'error'; error?: unknown };

export interface StageCtx {
  signal: AbortSignal;
  /** epoch ms when this stage must be done */
  deadline: number;
}

export async function runStage<T>(run: CheckRun, name: StageName, maxMs: number, fn: (ctx: StageCtx) => Promise<T>): Promise<StageResult<T>> {
  const ms = Math.min(maxMs, run.left());
  if (ms < 1000 || run.signal.aborted) {
    run.degraded.push(`${name}:skipped`);
    return { ok: false, reason: 'skipped' };
  }
  const ctrl = new AbortController();
  const signal = AbortSignal.any([run.signal, ctrl.signal]);
  const deadline = Date.now() + ms;
  let timer: NodeJS.Timeout | undefined;
  const cleanup = new AbortController();
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), ms);
    run.signal.addEventListener('abort', () => resolve('timeout'), { once: true, signal: cleanup.signal });
  });
  const work = Promise.resolve().then(() => fn({ signal, deadline }));
  // a late rejection from abandoned work must not become an unhandled rejection
  work.catch(() => undefined);
  try {
    const first = await Promise.race([work.then(value => ({ value })), timeout]);
    if (first === 'timeout') {
      ctrl.abort(new StageTimeout(name));
      run.degraded.push(`${name}:timeout`);
      run.log.warn(`stage ${name} timed out after ${ms}ms`);
      return { ok: false, reason: 'timeout' };
    }
    return { ok: true, value: first.value };
  } catch (error) {
    ctrl.abort(error);
    run.degraded.push(`${name}:error`);
    run.log.warn(`stage ${name} failed`, error);
    return { ok: false, reason: 'error', error };
  } finally {
    clearTimeout(timer);
    cleanup.abort();
  }
}

/** Await a promise but give up after `ms` (the promise keeps running; its result is ignored). */
export async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  p.catch(() => undefined);
  try {
    return await Promise.race([p, new Promise<T>(r => { timer = setTimeout(() => r(fallback), Math.max(0, ms)); })]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
