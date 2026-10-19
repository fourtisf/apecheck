'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ago, agoLong } from '@apecheck/core';

/** How often relative ages ("5m") refresh: the prototype re-renders them every 30 s. */
const AGE_TICK_MS = 30_000;

const NowCtx = createContext<number | null>(null);

/** One shared clock for every relative age on the page, so ages refresh without one timer per row. */
export function NowProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const t = window.setInterval(tick, AGE_TICK_MS);
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return <NowCtx.Provider value={now}>{children}</NowCtx.Provider>;
}

/** Current time in ms, refreshed every 30 s (Date.now() outside the provider). */
export function useNow(): number {
  return useContext(NowCtx) ?? Date.now();
}

export interface AgeProps {
  /** ISO string or ms */
  ts: string | number;
  /** "5m ago" / "just now" instead of "5m" / "now" */
  long?: boolean;
  className?: string;
}

/** Relative age that keeps itself fresh ("now", "5m", "3h", "2d"). Server and client clocks may differ by a tick, hence suppressHydrationWarning. */
export function Age({ ts, long = false, className }: AgeProps) {
  const now = useNow();
  return (
    <span className={className} suppressHydrationWarning>
      {long ? agoLong(ts, now) : ago(ts, now)}
    </span>
  );
}
