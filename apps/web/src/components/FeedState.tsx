'use client';
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { ChainKey, CoinKey, FeedResponse, NarKey } from '@apecheck/core';
import type { FeedParams, FeedTab, FeedType } from '@/lib/api';

/**
 * The feed's Verdicts list state, kept for the whole visit like the prototype's global S (S.tab, S.view, S.f,
 * S.limit): open a verdict, press Back (or come back through the Feed pill) and the list is the same tab, layout,
 * filters and rows. <Verdicts> unmounts on every navigation, so it can't keep this itself. In memory only: a full
 * reload starts from the defaults, and the server render (which never sees this) always matches the first paint.
 */

export interface FeedFilters {
  q: string;
  type: FeedType;
  nar: NarKey | 'any';
  coin: CoinKey | 'any';
  chain: ChainKey | 'any';
}
export const NO_FILTERS: FeedFilters = { q: '', type: 'all', nar: 'any', coin: 'any', chain: 'any' };

export type FeedLayout = 'list' | 'grid';

/** GET /v1/feed caps `q` at 120 characters (the page's server render trims and cuts it the same way). */
export const FEED_Q_MAX = 120;

export interface SavedFeed {
  tab: FeedTab;
  view: FeedLayout;
  f: FeedFilters;
  /** the rows on screen (with "Show 25 more" pages) and the feedKey of the params they were loaded for */
  rows: { key: string; res: FeedResponse } | null;
  /** a header search on another page asked for this list: scroll to it when the feed mounts */
  scrollToList?: boolean;
}

export const DEFAULT_FEED: SavedFeed = { tab: 'latest', view: 'list', f: NO_FILTERS, rows: null };

/** GET /v1/feed params for a tab and filters; the Watchlist tab asks for the watched ids, other tabs ignore them. */
export function feedParams(tab: FeedTab, f: FeedFilters, watchIds: readonly string[]): FeedParams {
  return {
    tab,
    type: f.type,
    nar: f.nar,
    coin: f.coin,
    chain: f.chain,
    q: f.q.trim() || undefined,
    ids: tab === 'watch' ? [...watchIds] : undefined,
  };
}

/** Identity of a list: two params with the same key show the same rows. */
export const feedKey = (p: FeedParams): string => JSON.stringify(p);

/** The params the page's server render loaded its first page with (app/page.tsx): latest, `?q=` only. */
export const serverFeedKey = (initialQ: string) => feedKey(feedParams('latest', { ...NO_FILTERS, q: initialQ }, []));

/** `?q=` of the address bar, as the page's server render reads it. */
export const urlQuery = (sp: Pick<URLSearchParams, 'get'> | null | undefined) => (sp?.get('q') ?? '').trim().slice(0, FEED_Q_MAX);

/**
 * Where the list starts when <Verdicts> mounts: the saved state, unless the address bar asks for a search the
 * saved state doesn't have (a direct link to /?q=, or the first visit), which works like the header search:
 * that text on the Latest tab, the other filters and the layout kept, and the list scrolled into view.
 */
export function restoreFeed(saved: SavedFeed | null, urlQ: string): SavedFeed & { scrollToList: boolean } {
  const base = saved ?? DEFAULT_FEED;
  if (urlQ && urlQ !== base.f.q.trim()) return { tab: 'latest', view: base.view, f: { ...base.f, q: urlQ }, rows: null, scrollToList: true };
  return { tab: base.tab, view: base.view, f: base.f, rows: base.rows, scrollToList: !!base.scrollToList };
}

/** What a header search on another page leaves for the feed before it navigates to /?q= (the prototype's S.f.q = v; S.tab = 'latest'). */
export function searchFeed(saved: SavedFeed | null, q: string): SavedFeed {
  const base = saved ?? DEFAULT_FEED;
  return { tab: 'latest', view: base.view, f: { ...base.f, q: q.trim().slice(0, FEED_Q_MAX) }, rows: null, scrollToList: true };
}

/**
 * The rows the list shows on mount, and the key they belong to:
 * - the server's first page, when it was rendered for these params and is at least as long as the saved rows;
 * - else the saved rows of the last visit (same params), shown at once so Back lands on the same list, then
 *   refreshed quietly (`refresh`);
 * - else nothing yet: the list loads for these params (key null).
 */
export function startRows(
  key: string,
  ssrKey: string,
  initial: FeedResponse | null,
  saved: SavedFeed['rows'],
): { res: FeedResponse | null; key: string | null; refresh: boolean } {
  const snap = saved && saved.key === key ? saved.res : null;
  if (key === ssrKey && initial && (!snap || initial.items.length >= snap.items.length)) return { res: initial, key, refresh: false };
  if (snap) return { res: snap, key, refresh: true };
  return { res: null, key: null, refresh: false };
}

export interface FeedStateApi {
  get(): SavedFeed | null;
  save(s: SavedFeed): void;
  /** header search from another page: filter the feed by `q` on the Latest tab once it mounts */
  search(q: string): void;
}

const noStore: FeedStateApi = { get: () => null, save() {}, search() {} };
const FeedStateCtx = createContext<FeedStateApi>(noStore);

/** Mounted once in AppProvider (the root layout persists across client navigation), above ActionsProvider. */
export function FeedStateProvider({ children }: { children: ReactNode }) {
  const ref = useRef<SavedFeed | null>(null);
  const api = useMemo<FeedStateApi>(
    () => ({
      get: () => ref.current,
      save(s) {
        ref.current = s;
      },
      search(q) {
        ref.current = searchFeed(ref.current, q);
      },
    }),
    [],
  );
  return <FeedStateCtx.Provider value={api}>{children}</FeedStateCtx.Provider>;
}

export const useFeedState = () => useContext(FeedStateCtx);
