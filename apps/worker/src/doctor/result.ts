/**
 * Doctor results: what one probe found, how it is classified, and the runner that gives every probe its own
 * timeout and never lets one throw.
 *
 * One rule for every dependency (classify):
 *  - FAIL: a request was sent and the answer was wrong or missing (with a key or on a keyless fallback alike), or
 *    required infrastructure is missing. Checks that need it will not work, and the command exits 1.
 *  - WARN: it answered, but on a keyless/public fallback, or only partly (a sub-call failed, slower than the
 *    pipeline's budget); or a recommended key is missing, so that part of every check is skipped.
 *  - SKIP: an optional dependency that is not configured (nothing was sent).
 *  - PASS: configured, and it answered as the check pipeline expects.
 */
export type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
export type Importance = 'required' | 'recommended' | 'optional';

export interface Finding {
  /** the probe's request(s) answered as expected; null when nothing was sent because it is not configured */
  ok: boolean | null;
  /** the key / URL this dependency wants is set (false: a keyless or public fallback answered) */
  configured: boolean;
  importance: Importance;
  /** answered, but only partly: a sub-call failed, or slower than the pipeline gives it */
  degraded?: boolean;
}

export function classify(f: Finding): Status {
  if (f.ok === false) return 'FAIL';
  if (f.ok === null) return f.importance === 'required' ? 'FAIL' : f.importance === 'recommended' ? 'WARN' : 'SKIP';
  if (!f.configured || f.degraded) return 'WARN';
  return 'PASS';
}

export interface ProbeOutcome {
  status: Status;
  /** what was seen (hosts only, never a key or a full URL) */
  detail: string;
  /** one line: which env var to set or what to run, and where to get the key (WARN / FAIL / SKIP only) */
  remedy?: string;
}

/** The outcome for a Finding; the remedy is dropped on PASS. */
export function outcome(f: Finding, detail: string, remedy?: string): ProbeOutcome {
  const status = classify(f);
  return status !== 'PASS' && remedy ? { status, detail, remedy } : { status, detail };
}

export const pass = (detail: string): ProbeOutcome => ({ status: 'PASS', detail });
export const fail = (detail: string, remedy?: string): ProbeOutcome => (remedy ? { status: 'FAIL', detail, remedy } : { status: 'FAIL', detail });
export const warn = (detail: string, remedy?: string): ProbeOutcome => (remedy ? { status: 'WARN', detail, remedy } : { status: 'WARN', detail });
export const skip = (detail: string, remedy?: string): ProbeOutcome => (remedy ? { status: 'SKIP', detail, remedy } : { status: 'SKIP', detail });

export interface Probe {
  /** the dependency, as the table shows it */
  name: string;
  /** default PROBE_TIMEOUT_MS */
  timeoutMs?: number;
  /** remedy shown when the probe times out or throws */
  remedy?: string;
  /** aborted when the probe's time is up */
  run(signal: AbortSignal): Promise<ProbeOutcome>;
}

export interface ProbeResult extends ProbeOutcome {
  name: string;
  ms: number;
}

export const PROBE_TIMEOUT_MS = 15_000;

/**
 * The line of a message that says what happened: the first non-empty one, past Prisma's
 * "Invalid `prisma.$queryRaw()` invocation:" lead-in (Playwright puts its call log after the first line).
 */
function firstLine(message: string): string {
  const lines = message.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l => !/^Invalid `.*` invocation:?$/.test(l)) ?? lines[0] ?? '';
}

/** Short message for any thrown value, with its code and cause (undici puts the network reason there). */
export function errorText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const cause = (e as { cause?: unknown }).cause;
    const base = firstLine(e.message) || (typeof code === 'string' ? code : e.name);
    const causeText = cause instanceof Error ? cause.message || String((cause as { code?: unknown }).code ?? '') : '';
    return causeText && !base.includes(causeText) ? `${base} (${causeText})` : base;
  }
  return typeof e === 'string' ? e : String(e);
}

const RE_NETWORK =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout after|socket hang up|other side closed|UND_ERR|certificate|could not resolve/i;

/** The fix when `error` says `host` could not be reached at all (DNS, refused, reset, timeout, TLS), else null. */
export function networkRemedy(error: string, host: string): string | null {
  if (!RE_NETWORK.test(error)) return null;
  return `no answer from ${host}: check DNS and outbound HTTPS from the VPS as user apecheck (curl -sSI https://${host}/); OUTBOUND_PROXY must stay empty in production`;
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/** Run one probe with its own timeout. Never throws: a timeout or an exception is a FAIL row. */
export async function runProbe(p: Probe, now: () => number = Date.now): Promise<ProbeResult> {
  const started = now();
  const limit = p.timeoutMs ?? PROBE_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), limit);
  });
  const work = Promise.resolve().then(() => p.run(ctrl.signal));
  // a late rejection from a probe that timed out must not become an unhandled rejection
  work.catch(() => undefined);
  const done = (o: ProbeOutcome): ProbeResult => ({ name: p.name, ms: now() - started, ...o });
  try {
    const first = await Promise.race([work.then(value => ({ value })), timeout]);
    if (first === 'timeout') {
      ctrl.abort(new Error('timeout'));
      return done(fail(`no answer: timed out after ${seconds(limit)}`, p.remedy));
    }
    return done(first.value);
  } catch (e) {
    return done(fail(errorText(e), p.remedy));
  } finally {
    clearTimeout(timer);
  }
}

/** Every probe at once (each has its own timeout); results in the probes' order. */
export function runProbes(probes: Probe[], now?: () => number): Promise<ProbeResult[]> {
  return Promise.all(probes.map(p => runProbe(p, now)));
}

export function tally(results: Pick<ProbeResult, 'status'>[]): Record<Status, number> {
  const out: Record<Status, number> = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) out[r.status]++;
  return out;
}

/** 1 when any probe failed, else 0 (WARN and SKIP never fail the command). */
export function exitCode(results: Pick<ProbeResult, 'status'>[]): 0 | 1 {
  return results.some(r => r.status === 'FAIL') ? 1 : 0;
}
