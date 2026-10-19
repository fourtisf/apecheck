import { Fragment, type ReactNode } from 'react';
import type { CheckReportDTO, Signal, StepDTO } from '@apecheck/core';

/** A check still in the queue or in the browser: the report shows the "Testing now" state. */
export const isRunning = (r: Pick<CheckReportDTO, 'status'>) => r.status === 'queued' || r.status === 'running';

/**
 * A run that ended without a verdict (it failed, or finished with no narrative score): the verdict panel says
 * "The check stopped before a verdict", so the tabs must not read as if the agent finished its work either.
 */
export const noVerdict = (r: Pick<CheckReportDTO, 'status' | 'narScore'>) => !isRunning(r) && (r.status === 'failed' || r.narScore == null);

/** Only plain http(s) links from scanned projects become hrefs; anything else (javascript:, data:, …) is dropped. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Status dot used in the facts lists ("ok" green, "warn" amber, "fail" red). Nothing when the signal is unknown. */
export function Dot({ s }: { s: Signal | null | undefined }) {
  return s ? <span className={`dot ${s}`} /> : null;
}

/** Shown in place of a fact the agent couldn't establish: never a made-up value. */
export function Unknown() {
  return <span className="muted">Unknown</span>;
}

export type FactRow = [label: string, value: ReactNode, source: string];

/** dl.facts with the prototype's three columns: label, value, source (the source column hides on phones). */
export function Facts({ rows }: { rows: FactRow[] }) {
  return (
    <dl className="facts">
      {rows.map(([label, value, src]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
          <dd className="src">{src}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Total run time in seconds: the stored duration, else the last step's offset. */
export function runSeconds(r: Pick<CheckReportDTO, 'durationMs' | 'steps'>): number | null {
  if (r.durationMs != null) return r.durationMs / 1000;
  const last = r.steps[r.steps.length - 1];
  return last ? last.t / 1000 : null;
}

/** Merge one streamed step into the list, in idx order; a step already shown is ignored. */
export function withStep(steps: StepDTO[], step: StepDTO): StepDTO[] {
  if (steps.some(s => s.idx === step.idx)) return steps;
  const next = [...steps, step];
  if (steps.length && steps[steps.length - 1].idx > step.idx) next.sort((a, b) => a.idx - b.idx);
  return next;
}
