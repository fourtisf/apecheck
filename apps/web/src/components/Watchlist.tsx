'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * M1 watchlist: check ids kept in this browser (localStorage 'apecheck-watch'). The feed's Watchlist tab
 * asks GET /v1/feed?tab=watch&ids=... which follows each id to its target's latest verdict.
 * M3 moves it to the signed-in account (POST /v1/watch/:targetId).
 */
export const WATCH_KEY = 'apecheck-watch';
/** GET /v1/feed accepts at most this many ids. */
export const WATCH_MAX_IDS = 100;

export interface WatchlistApi {
  /** newest first */
  ids: string[];
  has(id: string): boolean;
  /** adds or removes; returns true when the id is now watched */
  toggle(id: string): boolean;
  /** false during the server render and first client render (localStorage not read yet) */
  ready: boolean;
}

const WatchCtx = createContext<WatchlistApi>({ ids: [], has: () => false, toggle: () => false, ready: false });

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))] : [];
  } catch {
    return [];
  }
}

function write(ids: string[]) {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(ids));
  } catch {
    /* storage full or blocked: the list still works for this visit */
  }
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setIds(read());
    setReady(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === WATCH_KEY) setIds(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback((id: string) => {
    const cur = read();
    const on = !cur.includes(id);
    const next = on ? [id, ...cur] : cur.filter(x => x !== id);
    write(next);
    setIds(next);
    return on;
  }, []);

  const api = useMemo<WatchlistApi>(() => {
    const set = new Set(ids);
    return { ids, has: id => set.has(id), toggle, ready };
  }, [ids, toggle, ready]);

  return <WatchCtx.Provider value={api}>{children}</WatchCtx.Provider>;
}

export const useWatchlist = () => useContext(WatchCtx);
