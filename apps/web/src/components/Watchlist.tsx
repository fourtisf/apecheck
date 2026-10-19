'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MeDTO, WatchlistResponse } from '@apecheck/core';
import { feed, isApiError, unwatch, watch as postWatch, watchlist as fetchWatchlist } from '@/lib/api';
import { useMe } from './Me';
import { useToast } from './Toast';

/**
 * The watchlist, in one of two places:
 * - signed out ('local'): check ids kept in this browser (localStorage 'apecheck-watch'). The feed's Watchlist tab
 *   asks GET /v1/feed?tab=watch&ids=... which follows each id to its target's latest verdict.
 * - signed in ('account'): the account's watched targets (POST/DELETE /v1/watch/:targetId, GET /v1/watchlist), which
 *   is what re-check alerts follow. On sign-in, the ids kept in this browser move to the account (their targets are
 *   resolved through /v1/feed?ids=, a long list in several passes) and leave the browser's list as they move.
 */
export const WATCH_KEY = 'apecheck-watch';
/** GET /v1/feed accepts at most this many ids. */
export const WATCH_MAX_IDS = 100;

/** What a watch toggle needs: the check's short id (browser list) and its target (account list). */
export interface WatchItem {
  id: string;
  targetId: string;
}

export interface WatchlistApi {
  mode: 'local' | 'account';
  /** false until the list is known: localStorage read (signed out) or GET /v1/watchlist answered (signed in) */
  ready: boolean;
  /** signed out: watched check ids, newest first ([] when signed in) */
  ids: string[];
  /** signed in: the account's watchlist (latest check of every watched target); null until loaded */
  list: WatchlistResponse | null;
  /** how many projects are watched (the Watchlist tab's count) */
  count: number;
  isWatching(it: WatchItem): boolean;
  /**
   * Watch or stop watching. Signed in it calls the API (throws ApiRequestError, e.g. 409 watchlist_full); signed out it
   * changes the browser's list. Resolves to the new state.
   */
  setWatching(it: WatchItem, on: boolean): Promise<boolean>;
  /** signed in: GET /v1/watchlist again */
  reload(): Promise<void>;
  /** bumps whenever the account's list was reloaded */
  version: number;
}

/** The empty Watchlist tab, by what watching gets this viewer (the same rule as the Watch toast, report/ReportHeader watchToast). */
export function watchEmptyText(me: Pick<MeDTO, 'tier' | 'tokenLive' | 'user'> | null): string {
  const head = 'Nothing on your watchlist yet. Open any verdict and press Watch to keep it here';
  if (me?.user && me.tier === 'max') return `${head}; it's re-checked on its own when the site or contract changes.`;
  if (me?.user && me.tier === 'pro') return `${head} and get an alert when the site or contract changes.`;
  return `${head}. Re-check alerts come with Pro${me?.tokenLive ? '' : ', which opens at token launch'}.`;
}

const noop: WatchlistApi = {
  mode: 'local',
  ready: false,
  ids: [],
  list: null,
  count: 0,
  isWatching: () => false,
  setWatching: async () => false,
  reload: async () => {},
  version: 0,
};
const WatchCtx = createContext<WatchlistApi>(noop);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function readLocal(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))] : [];
  } catch {
    return [];
  }
}

function writeLocal(ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(WATCH_KEY, JSON.stringify(ids));
    else localStorage.removeItem(WATCH_KEY);
  } catch {
    /* storage full or blocked: the list still works for this visit */
  }
}

/** POST /v1/watch calls one migration pass may spend: the route allows 60 a minute, so the user's own Watch clicks keep room. */
export const MIGRATE_PER_PASS = 40;
/** after a pass that had to stop (rate limit, the per-pass cap), the next one waits this long */
export const MIGRATE_RETRY_MS = 65_000;

export interface MigrateResult {
  /** targets added to the account by this pass */
  moved: number;
  /** browser ids that can leave the browser's list: moved, already on the account, gone or private, or the account is full */
  done: string[];
  /** ids are left that another pass should take (it stopped early, or the list is longer than one pass) */
  more: boolean;
}

/**
 * One pass of moving the browser's watched check ids to the account: the first WATCH_MAX_IDS ids are resolved to their
 * targets (via /v1/feed?ids=, public checks only), and each target the account doesn't watch yet is watched with
 * POST /v1/watch/:targetId, at most `perPass` of them. A 429 stops the pass with what it moved so far (the caller drops
 * only `done` from the browser and runs another pass later, which skips what is already on the account); a full
 * watchlist ends the move (every id is done); a network error before anything moved throws (everything is kept).
 */
export async function migrateLocalWatchlist(
  ids: string[],
  deps: {
    resolve: (ids: string[]) => Promise<{ id: string; targetId: string }[]>;
    watch: (targetId: string) => Promise<unknown>;
    /** the targets the account already watches (GET /v1/watchlist); they cost no request */
    watched?: () => Promise<Iterable<string>>;
  },
  perPass: number = MIGRATE_PER_PASS,
): Promise<MigrateResult> {
  if (!ids.length) return { moved: 0, done: [], more: false };
  const batch = ids.slice(0, WATCH_MAX_IDS);
  const items = await deps.resolve(batch);
  let known: ReadonlySet<string> = new Set();
  if (deps.watched) {
    try {
      known = new Set(await deps.watched());
    } catch {
      /* every target gets its POST; the API answers an existing watch at no cost */
    }
  }
  const targets = [...new Set(items.map(i => i.targetId).filter(Boolean))];
  /** targets that are on the account now (moved, already watched) or never will be (gone) */
  const settled = new Set(targets.filter(t => known.has(t)));
  let moved = 0;
  let sent = 0;
  let stopped = false;
  for (const t of targets) {
    if (settled.has(t)) continue;
    if (sent >= perPass) {
      stopped = true;
      break;
    }
    sent++;
    try {
      await deps.watch(t);
      moved++;
      settled.add(t);
    } catch (e) {
      if (isApiError(e, 'not_found')) {
        settled.add(t);
        continue;
      }
      // the account can't take more: the rest of the browser's list goes too (it would fail on every visit)
      if (isApiError(e, 'watchlist_full')) return { moved, done: [...ids], more: false };
      if (isApiError(e) && (e.status === 429 || e.code === 'rate_limited')) {
        stopped = true;
        break;
      }
      // offline or the API failed: keep everything unless this pass already got somewhere
      if (!moved) throw e;
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    // the whole batch went through: its ids are done, including the ones the feed didn't return (gone or private)
    return { moved, done: batch, more: ids.length > batch.length };
  }
  // stopped part-way: only the ids whose target is known to be settled can go; the next pass skips what moved
  const inBatch = new Set(batch);
  const done = [...new Set(items.filter(i => inBatch.has(i.id) && settled.has(i.targetId)).map(i => i.id))];
  return { moved, done, more: true };
}

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const { me, loaded: meLoaded } = useMe();
  const toast = useToast();
  const userId = me?.user?.id ?? null;
  const mode: WatchlistApi['mode'] = userId ? 'account' : 'local';

  const [ids, setIds] = useState<string[]>([]);
  const [localReady, setLocalReady] = useState(false);
  const [list, setList] = useState<WatchlistResponse | null>(null);
  const [targets, setTargets] = useState<ReadonlySet<string>>(new Set());
  const [version, setVersion] = useState(0);
  const loadSeq = useRef(0);
  const userRef = useRef(userId);
  userRef.current = userId;

  // the browser's list (signed out), kept in sync across tabs
  useEffect(() => {
    setIds(readLocal());
    setLocalReady(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === WATCH_KEY || e.key === null) setIds(readLocal());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const reload = useCallback(async () => {
    const forUser = userRef.current;
    if (!forUser) return;
    const my = ++loadSeq.current;
    try {
      const res = await fetchWatchlist();
      if (my !== loadSeq.current || userRef.current !== forUser) return;
      setList(res);
      setTargets(new Set(res.targetIds));
      setVersion(v => v + 1);
    } catch {
      // keep what we had; the report's own `watching` still shows the state
    }
  }, []);

  // signed in: move the browser's list to the account, then load the account's list. A long list moves in passes
  // (MIGRATE_PER_PASS watches each, MIGRATE_RETRY_MS apart); each pass drops only the ids it settled from the browser,
  // so a reload or the next visit carries on where it stopped instead of starting over.
  useEffect(() => {
    setList(null);
    setTargets(new Set());
    if (!userId) return;
    let stop = false;
    let wake: (() => void) | null = null;
    let timer: number | undefined;
    const pause = (ms: number) =>
      new Promise<void>(resolve => {
        wake = resolve;
        timer = window.setTimeout(resolve, ms);
      });
    void (async () => {
      for (;;) {
        const local = readLocal();
        let more = false;
        if (local.length) {
          try {
            const res = await migrateLocalWatchlist(local, {
              resolve: async batch => (await feed({ tab: 'watch', ids: batch, limit: WATCH_MAX_IDS })).items,
              watch: postWatch,
              watched: async () => (await fetchWatchlist()).targetIds,
            });
            if (stop || userRef.current !== userId) return;
            const done = new Set(res.done);
            // re-read: the visitor may have changed the list in another tab meanwhile
            const left = readLocal().filter(id => !done.has(id));
            writeLocal(left);
            setIds(left);
            if (res.moved) toast(`Moved ${res.moved} watched project${res.moved === 1 ? '' : 's'} from this browser to your watchlist`);
            more = res.more && left.length > 0;
          } catch {
            // offline or the API failed: try again on the next sign-in or visit
          }
        }
        if (stop) return;
        await reload();
        if (!more || stop) return;
        await pause(MIGRATE_RETRY_MS);
        if (stop) return;
      }
    })();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      wake?.();
    };
  }, [userId, reload, toast]);

  const setWatching = useCallback(
    async (it: WatchItem, on: boolean) => {
      if (userRef.current) {
        const res = on ? await postWatch(it.targetId) : await unwatch(it.targetId);
        setTargets(prev => {
          const next = new Set(prev);
          if (res.watching) next.add(it.targetId);
          else next.delete(it.targetId);
          return next;
        });
        void reload();
        return res.watching;
      }
      const cur = readLocal();
      const next = on ? [it.id, ...cur.filter(x => x !== it.id)] : cur.filter(x => x !== it.id);
      writeLocal(next);
      setIds(next);
      return on;
    },
    [reload],
  );

  const api = useMemo<WatchlistApi>(() => {
    const local = new Set(ids);
    const account = mode === 'account';
    return {
      mode,
      ready: account ? list !== null : meLoaded && localReady,
      ids: account ? [] : ids,
      list: account ? list : null,
      count: account ? targets.size : ids.length,
      isWatching: it => (account ? targets.has(it.targetId) : local.has(it.id)),
      setWatching,
      reload,
      version,
    };
  }, [mode, ids, list, targets, meLoaded, localReady, setWatching, reload, version]);

  return <WatchCtx.Provider value={api}>{children}</WatchCtx.Provider>;
}

export const useWatchlist = () => useContext(WatchCtx);
