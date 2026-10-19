'use client';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NAR_LABEL, narBand, type CheckReportDTO, type LiveCheckDTO } from '@apecheck/core';
import { live as fetchLive, report as fetchReport, isApiError } from '@/lib/api';
import { reportPath } from '@/lib/env';
import { useToast } from './Toast';

/** HANDOFF §6: the feed's "Checking right now" cards poll GET /v1/live every 3 s. */
export const LIVE_POLL_MS = 3000;
/** My checks are remembered across reloads in this tab for this long (the API gives up on a queued job after 2 h). */
const MINE_TTL_MS = 2 * 3600_000;
const MINE_KEY = 'apecheck-mine';

export interface LiveState {
  /** running/queued public checks, newest first; null until the first answer */
  items: LiveCheckDTO[] | null;
  /** client clock when `items` arrived: elapsed now = item.elapsedMs + (Date.now() - receivedAt) */
  receivedAt: number;
  /** the last poll failed */
  error: boolean;
}

export interface LiveApi extends LiveState {
  /**
   * Keep polling while a view shows live checks (the feed). Pass the server-rendered items so a check
   * that finished between the server render and the first poll still counts as finished.
   * Returns the unsubscribe function.
   */
  subscribe(seed?: LiveCheckDTO[] | null): () => void;
  /** The viewer just started this check: poll until it's done, then toast "Your check on … is done". */
  trackMine(id: string): void;
  /** Called with the ids that left /v1/live since the last poll (finished, failed or dropped). Returns unsubscribe. */
  onFinished(cb: (ids: string[]) => void): () => void;
}

const LiveCtx = createContext<LiveApi>({
  items: null,
  receivedAt: 0,
  error: false,
  subscribe: () => () => {},
  trackMine() {},
  onFinished: () => () => {},
});

function readMine(): Map<string, number> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(MINE_KEY) || '{}') as Record<string, unknown>;
    const now = Date.now();
    return new Map(
      Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number' && now - e[1] < MINE_TTL_MS && /^[A-Za-z0-9_-]{1,64}$/.test(e[0])),
    );
  } catch {
    return new Map();
  }
}

function writeMine(m: Map<string, number>) {
  try {
    sessionStorage.setItem(MINE_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch {
    /* storage blocked: tracking still works until reload */
  }
}

function doneText(r: CheckReportDTO): string {
  if (r.status === 'failed') return `Your check on ${r.name} stopped before a verdict.`;
  if (r.narScore == null) return `Your check on ${r.name} is done.`;
  const key = r.narBand ?? narBand(r.narScore).key;
  return `Your check on ${r.name} is done: ${NAR_LABEL[key]} ${r.narScore}`;
}

/**
 * Shared /v1/live poller and the global "your check is done" notifier. It polls only while a view
 * subscribes or while one of the viewer's own checks is running, and pauses in background tabs.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const pathname = usePathname();
  const [state, setState] = useState<LiveState>({ items: null, receivedAt: 0, error: false });

  const subs = useRef(0);
  const mine = useRef<Map<string, number>>(new Map());
  const prevIds = useRef<Set<string> | null>(null);
  const listeners = useRef(new Set<(ids: string[]) => void>());
  const inflight = useRef(false);
  const checking = useRef(new Set<string>());
  const path = useRef(pathname);
  useEffect(() => {
    path.current = pathname;
  }, [pathname]);

  const untrack = useCallback((id: string) => {
    if (mine.current.delete(id)) writeMine(mine.current);
  }, []);

  const settleMine = useCallback(
    async (id: string) => {
      if (checking.current.has(id)) return;
      checking.current.add(id);
      try {
        const r = await fetchReport(id);
        if (r.status !== 'done' && r.status !== 'failed') return; // still running, just not in the newest 8
        untrack(id);
        // the report page shows its own verdict landing
        if (path.current !== reportPath(id)) toast(doneText(r), id);
      } catch (e) {
        if (isApiError(e, 'not_found')) untrack(id);
      } finally {
        checking.current.delete(id);
      }
    },
    [toast, untrack],
  );

  const poll = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetchLive();
      const ids = new Set(res.items.map(i => i.id));
      let changed = false;
      for (const it of res.items) {
        if (it.mine && !mine.current.has(it.id)) {
          mine.current.set(it.id, Date.now());
          changed = true;
        }
      }
      if (changed) writeMine(mine.current);
      const before = prevIds.current;
      prevIds.current = ids;
      setState({ items: res.items, receivedAt: Date.now(), error: false });
      if (before) {
        const gone = [...before].filter(id => !ids.has(id));
        if (gone.length) listeners.current.forEach(cb => cb(gone));
      }
      for (const id of [...mine.current.keys()]) if (!ids.has(id)) void settleMine(id);
    } catch {
      setState(s => ({ ...s, error: true }));
    } finally {
      inflight.current = false;
    }
  }, [settleMine]);

  const tick = useCallback(() => {
    if (document.hidden) return;
    if (subs.current === 0 && mine.current.size === 0) return;
    void poll();
  }, [poll]);

  useEffect(() => {
    mine.current = readMine();
    const t = window.setInterval(tick, LIVE_POLL_MS);
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVis);
    if (mine.current.size) tick();
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [tick]);

  const subscribe = useCallback(
    (seed?: LiveCheckDTO[] | null) => {
      // a view mounting fresh from the server knows the current list better than a poll from minutes ago
      if (seed && (subs.current === 0 || !prevIds.current)) prevIds.current = new Set(seed.map(i => i.id));
      subs.current += 1;
      tick();
      return () => {
        subs.current = Math.max(0, subs.current - 1);
      };
    },
    [tick],
  );

  const trackMine = useCallback((id: string) => {
    mine.current.set(id, Date.now());
    writeMine(mine.current);
  }, []);

  const onFinished = useCallback((cb: (ids: string[]) => void) => {
    listeners.current.add(cb);
    return () => {
      listeners.current.delete(cb);
    };
  }, []);

  const api = useMemo<LiveApi>(() => ({ ...state, subscribe, trackMine, onFinished }), [state, subscribe, trackMine, onFinished]);
  return <LiveCtx.Provider value={api}>{children}</LiveCtx.Provider>;
}

export const useLive = () => useContext(LiveCtx);
