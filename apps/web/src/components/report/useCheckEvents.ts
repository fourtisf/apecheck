'use client';
import { useEffect, useRef } from 'react';
import type { CheckReportDTO, CheckStatusS, StepDTO } from '@apecheck/core';
import { eventsUrl, isAbortError, isApiError, report as fetchReport } from '@/lib/api';

export interface CheckEventHandlers {
  /** a log step (stored ones are replayed first on every connect, so the same idx can come twice) */
  step(step: StepDTO & { progress: number }): void;
  status(s: { status: CheckStatusS; progress: number }): void;
  /** the finished (or failed) report */
  done(report: CheckReportDTO): void;
  /** the check no longer exists (expired, or private to someone else) */
  gone(): void;
}

const MAX_BACKOFF_MS = 30_000;

function parse<T>(e: Event): T | null {
  try {
    return JSON.parse((e as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

/**
 * GET /v1/checks/:id/events while `enabled` (the check is queued or running). The browser's own
 * EventSource retry is replaced by ours: on a dropped stream we first ask the report endpoint whether
 * the check finished meanwhile (so a missed `done` still lands), then reconnect with backoff.
 * The stream is closed on `done`, when `enabled` turns false and on unmount.
 */
export function useCheckEvents(id: string, enabled: boolean, handlers: CheckEventHandlers) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let stopped = false;
    let failures = 0;
    let timer: number | undefined;
    const ctrl = new AbortController();

    const stop = () => {
      stopped = true;
      es?.close();
      es = null;
    };

    const connect = () => {
      if (stopped) return;
      const src = new EventSource(eventsUrl(id), { withCredentials: true });
      es = src;
      src.addEventListener('step', e => {
        failures = 0;
        const d = parse<StepDTO & { progress: number }>(e);
        if (d && typeof d.idx === 'number') ref.current.step(d);
      });
      src.addEventListener('status', e => {
        failures = 0;
        const d = parse<{ status: CheckStatusS; progress: number }>(e);
        if (d) ref.current.status(d);
      });
      src.addEventListener('done', e => {
        stop();
        const d = parse<CheckReportDTO>(e);
        if (d && d.id) ref.current.done(d);
        else void settle();
      });
      src.onerror = () => {
        src.close();
        if (es === src) es = null;
        if (stopped) return;
        failures += 1;
        void settle();
      };
    };

    const settle = async () => {
      try {
        const r = await fetchReport(id, { signal: ctrl.signal });
        if (stopped && r.status !== 'done' && r.status !== 'failed') return;
        if (r.status === 'done' || r.status === 'failed') {
          stop();
          ref.current.done(r);
          return;
        }
      } catch (e) {
        if (isAbortError(e) || ctrl.signal.aborted) return;
        if (isApiError(e, 'not_found')) {
          stop();
          ref.current.gone();
          return;
        }
      }
      if (stopped) return;
      const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 5));
      timer = window.setTimeout(connect, base * (0.75 + Math.random() * 0.5));
    };

    connect();
    return () => {
      stop();
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [id, enabled]);
}
