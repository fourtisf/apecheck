'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MeDTO } from '@apecheck/core';
import { me as fetchMe } from '@/lib/api';

export interface MeApi {
  /** null until GET /v1/me answers (the session cookie lives on the API origin, so the server can't render it) */
  me: MeDTO | null;
  refresh(): Promise<MeDTO | null>;
  /** apply the credits count a POST /v1/checks returned, before the next refresh */
  setCredits(credits: number): void;
}

const MeCtx = createContext<MeApi>({ me: null, refresh: async () => null, setCredits() {} });

/** Re-read /v1/me when the tab comes back after this long (credits reset at 00:00 UTC, other tabs spend them). */
const STALE_MS = 60_000;

export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDTO | null>(null);
  const loadedAt = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const m = await fetchMe();
      loadedAt.current = Date.now();
      setMe(m);
      return m;
    } catch {
      return null;
    }
  }, []);

  const setCredits = useCallback((credits: number) => setMe(m => (m ? { ...m, credits: Math.max(0, credits) } : m)), []);

  useEffect(() => {
    void refresh();
    const onVis = () => {
      if (!document.hidden && Date.now() - loadedAt.current > STALE_MS) void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  // credits come back at 00:00 UTC: refresh right after the reset if the page stays open
  const resetsAt = me?.resetsAt;
  useEffect(() => {
    if (!resetsAt) return;
    const ms = new Date(resetsAt).getTime() - Date.now() + 2000;
    if (!Number.isFinite(ms) || ms <= 0 || ms > 2 ** 31 - 1) return;
    const t = window.setTimeout(() => void refresh(), ms);
    return () => window.clearTimeout(t);
  }, [resetsAt, refresh]);

  const api = useMemo(() => ({ me, refresh, setCredits }), [me, refresh, setCredits]);
  return <MeCtx.Provider value={api}>{children}</MeCtx.Provider>;
}

export const useMe = () => useContext(MeCtx);
