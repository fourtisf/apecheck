'use client';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CHAINS, CHAIN_ORDER, COIN_BANDS, NAR_BANDS, type FeedResponse } from '@apecheck/core';
import { feed, isAbortError, watchlist as fetchWatchlist, type FeedParams, type FeedTab, type FeedType } from '@/lib/api';
import { GridIcon, ListIcon, SearchIcon } from '../icons';
import { useLive } from '../Live';
import { useMe } from '../Me';
import { useFeedSearchRequest } from '../Actions';
import {
  FEED_Q_MAX,
  NO_FILTERS,
  accountWatchKey,
  feedKey,
  feedParams,
  filterRows,
  restoreFeed,
  serverFeedKey,
  startRows,
  urlQuery,
  useFeedState,
  type FeedFilters,
  type FeedLayout,
} from '../FeedState';
import { useToast } from '../Toast';
import { VerdictCard } from '../VerdictCard';
import { VerdictTable } from '../VerdictTable';
import { WATCH_MAX_IDS, useWatchlist, watchEmptyText } from '../Watchlist';

const TABS: [FeedTab, string][] = [
  ['latest', 'Latest'],
  ['checked', 'Most checked'],
  ['real', 'Most real'],
  ['least', 'Least real'],
  ['vol', '5m volume'],
  ['watch', 'Watchlist'],
];
const TYPES: [FeedType, string][] = [
  ['all', 'All'],
  ['coin', 'Coins'],
  ['post', 'Posts'],
  ['site', 'Sites'],
];

/** "Show 25 more" */
const PAGE = 25;
/** GET /v1/feed limit cap: a refresh reloads at most this many rows */
const MAX_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 250;
/** a verdict that just landed keeps its .fresh highlight class this long (the animation itself is 4 s) */
const FRESH_MS = 6000;

type Filters = FeedFilters;

/** A one-off instruction from the page: switch tab ("Most checked today → All") and scroll to the list. */
export interface VerdictsCommand {
  tab: FeedTab;
  n: number;
}

const scrollToList = (smooth: boolean) =>
  window.setTimeout(() => document.getElementById('ftabs')?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }), 50);

const dedupe = (items: FeedResponse['items']) => {
  const seen = new Set<string>();
  return items.filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)));
};

/**
 * The Verdicts list: tabs, list/grid toggle, filters, table or cards, cursor paging, empty states.
 * The first page comes from the server render; every change after that asks GET /v1/feed.
 * When a live check finishes the list reloads and the new verdicts flash (.fresh).
 * Tab, layout, filters and rows outlive the page (useFeedState), so leaving for a report and coming back shows the
 * same list, as in the prototype.
 */
export function Verdicts({ initial, initialQ, command }: { initial: FeedResponse | null; initialQ: string; command: VerdictsCommand | null }) {
  const watch = useWatchlist();
  const { me } = useMe();
  const { onFinished } = useLive();
  const toast = useToast();
  const searchReq = useFeedSearchRequest();
  const store = useFeedState();
  const searchParams = useSearchParams();

  // the list as the visitor left it, or the address bar's ?q= (read from the URL itself: after Back the server props
  // can belong to an older URL, see useUrlSearchParams in pages/useApiQuery.ts)
  const [start] = useState(() => restoreFeed(store.get(), urlQuery(searchParams)));
  const [tab, setTab] = useState<FeedTab>(start.tab);
  const [view, setView] = useState<FeedLayout>(start.view);
  const [qInput, setQInput] = useState(start.f.q);
  const [f, setF] = useState<Filters>(start.f);

  // signed in, the Watchlist tab shows the account's list (GET /v1/watchlist, filtered here); signed out it asks the
  // feed for this browser's watched ids (newest first). Other tabs ignore both.
  const accountWatch = tab === 'watch' && watch.mode === 'account';
  const watchKey = tab === 'watch' && !accountWatch ? watch.ids.slice(0, WATCH_MAX_IDS).join(',') : '';
  const params = useMemo<FeedParams>(() => feedParams(tab, f, watchKey ? watchKey.split(',') : []), [tab, f, watchKey]);
  const key = accountWatch ? accountWatchKey(f) : feedKey(params);

  // rows to start with: the server's page when it was rendered for these params, else the rows of the last visit
  const [boot] = useState(() => startRows(key, serverFeedKey(initialQ), initial, start.rows));
  const [data, setData] = useState<FeedResponse | null>(boot.res);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const accountRef = useRef(accountWatch);
  accountRef.current = accountWatch;
  const fRef = useRef(f);
  fRef.current = f;
  const dataRef = useRef(data);
  dataRef.current = data;
  /** the params `data` was loaded for (null: nothing loaded yet) */
  const loadedKey = useRef<string | null>(boot.key);
  const seq = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const freshTimer = useRef<number | undefined>(undefined);

  /**
   * replace: new filters → first page. refresh: same filters, keep as many rows as are shown, flash new ones.
   * sync: a refresh that doesn't flash (the saved rows of the last visit brought up to date).
   */
  const load = useCallback(async (mode: 'replace' | 'refresh' | 'sync') => {
    const p = paramsRef.current;
    const account = accountRef.current;
    const k = account ? accountWatchKey(fRef.current) : feedKey(p);
    if (p.tab === 'watch' && !account && !p.ids?.length) {
      seq.current++;
      abort.current?.abort();
      loadedKey.current = k;
      setData({ items: [], total: 0, nextCursor: null });
      setFailed(false);
      return;
    }
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    const my = ++seq.current;
    const shown = dataRef.current?.items.length ?? 0;
    const limit = mode === 'replace' ? PAGE : Math.min(MAX_LIMIT, Math.max(PAGE, shown));
    try {
      let res: FeedResponse;
      if (account) {
        const items = filterRows((await fetchWatchlist({ signal: ac.signal })).items, fRef.current);
        res = { items, total: items.length, nextCursor: null };
      } else {
        res = await feed({ ...p, limit }, { signal: ac.signal });
      }
      if (my !== seq.current) return;
      if (mode === 'refresh' && dataRef.current) {
        const before = new Set(dataRef.current.items.map(i => i.id));
        const added = res.items.filter(i => !before.has(i.id)).map(i => i.id);
        if (added.length) {
          setFresh(new Set(added));
          window.clearTimeout(freshTimer.current);
          freshTimer.current = window.setTimeout(() => setFresh(new Set()), FRESH_MS);
        }
      }
      loadedKey.current = k;
      setData(res);
      setFailed(false);
    } catch (e) {
      if (isAbortError(e) || my !== seq.current) return;
      if (mode === 'replace') {
        loadedKey.current = k;
        setData(null);
        setFailed(true);
      }
    }
  }, []);

  // filters, tab or watchlist changed (signed out, the Watchlist tab waits until this browser's list was read)
  useEffect(() => {
    if (tab === 'watch' && !accountWatch && !watch.ready) return;
    if (key === loadedKey.current) return;
    void load('replace');
  }, [key, tab, accountWatch, watch.ready, load]);

  // signed in: the account's watchlist changed (a sign-in moved this browser's list there): show it
  const watchVersion = watch.version;
  useEffect(() => {
    if (accountRef.current && loadedKey.current === key) void load('sync');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchVersion]);

  // the saved rows of the last visit are on screen: bring them up to date
  useEffect(() => {
    if (boot.refresh) void load('sync');
  }, [boot, load]);

  // a live check finished: reload what's shown and flash the new verdicts
  useEffect(() => onFinished(() => void load('refresh')), [onFinished, load]);

  // keep the list for the next visit (tab, layout, filters and the rows with the params they were loaded for)
  useEffect(() => {
    store.save({ tab, view, f, rows: data && loadedKey.current ? { key: loadedKey.current, res: data } : null });
  }, [store, tab, view, f, data]);

  useEffect(
    () => () => {
      abort.current?.abort();
      window.clearTimeout(freshTimer.current);
    },
    [],
  );

  // search box → filter, debounced
  useEffect(() => {
    const t = window.setTimeout(() => setF(prev => (prev.q === qInput ? prev : { ...prev, q: qInput })), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [qInput]);

  // arrived from the header search on another page (/?q=...): show the list
  useEffect(() => {
    if (start.scrollToList) scrollToList(false);
  }, [start]);

  // once the filter moves away from the address bar's ?q=..., drop it from the address bar
  useEffect(() => {
    const urlQ = new URLSearchParams(window.location.search).get('q');
    if (urlQ != null && urlQ.trim().slice(0, FEED_Q_MAX) !== f.q.trim()) window.history.replaceState(null, '', '/');
  }, [f.q]);

  // header search on this page: filter the feed by the text and scroll to it
  const handledSearch = useRef(searchReq?.n ?? 0);
  useEffect(() => {
    if (!searchReq || searchReq.n === handledSearch.current) return;
    handledSearch.current = searchReq.n;
    setQInput(searchReq.q);
    setF(prev => ({ ...prev, q: searchReq.q }));
    setTab('latest');
    scrollToList(false);
  }, [searchReq]);

  const handledCmd = useRef(command?.n ?? 0);
  useEffect(() => {
    if (!command || command.n === handledCmd.current) return;
    handledCmd.current = command.n;
    setTab(command.tab);
    scrollToList(true);
  }, [command]);

  async function loadMore() {
    const cursor = data?.nextCursor;
    if (!cursor || loadingMore) return;
    const my = seq.current;
    setLoadingMore(true);
    try {
      const res = await feed({ ...params, cursor, limit: PAGE });
      if (my !== seq.current) return;
      setData(d => (d ? { items: dedupe([...d.items, ...res.items]), total: res.total, nextCursor: res.nextCursor } : res));
    } catch {
      if (my === seq.current) toast("Couldn't load more verdicts. Try again in a moment.");
    } finally {
      setLoadingMore(false);
    }
  }

  function clearFilters() {
    setQInput('');
    setF(NO_FILTERS);
    if (tab === 'watch') setTab('latest');
  }

  const items = data?.items ?? [];
  const filtersActive = f.q.trim() !== '' || f.type !== 'all' || f.nar !== 'any' || f.coin !== 'any' || f.chain !== 'any';

  let rows: ReactNode = null;
  if (failed) {
    rows = (
      <div className="tbl">
        <div className="tbl-empty" style={{ borderTop: 0 }}>
          Couldn&apos;t load verdicts right now.
          <br />
          <button className="btn sm" type="button" onClick={() => void load('replace')}>
            Try again
          </button>
        </div>
      </div>
    );
  } else if (data && !items.length) {
    let body: ReactNode;
    if (tab === 'watch' && (accountWatch ? watch.count === 0 && !filtersActive : watch.ids.length === 0)) {
      body = watchEmptyText(me);
    } else if (!filtersActive && tab !== 'watch') {
      body = 'No verdicts yet. Paste a contract address, an X post or a link above to run the first check.';
    } else {
      body = (
        <>
          No verdicts match these filters.
          <br />
          <button className="btn sm" type="button" onClick={clearFilters}>
            Clear filters
          </button>
        </>
      );
    }
    rows = (
      <div className="tbl">
        <div className="tbl-empty" style={{ borderTop: 0 }}>
          {body}
        </div>
      </div>
    );
  } else if (items.length) {
    rows =
      view === 'grid' ? (
        <div className="gview">
          {items.map(it => (
            <VerdictCard key={it.id} item={it} fresh={fresh.has(it.id)} />
          ))}
        </div>
      ) : (
        <VerdictTable items={items} fresh={fresh} />
      );
  }

  return (
    <>
      <div className="ftabs" id="ftabs">
        <div className="tabs-pill" role="tablist">
          {TABS.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {l}
              {k === 'watch' ? <small>{watch.count}</small> : null}
            </button>
          ))}
        </div>
        <div className="vt" role="group" aria-label="Layout">
          <button type="button" aria-pressed={view === 'list'} aria-label="List view" onClick={() => setView('list')}>
            <ListIcon />
          </button>
          <button type="button" aria-pressed={view === 'grid'} aria-label="Grid view" onClick={() => setView('grid')}>
            <GridIcon />
          </button>
        </div>
      </div>
      <div className="fbar">
        <label className="fsearch">
          <SearchIcon />
          <input
            id="fq"
            placeholder="Search name, CA, $ticker or dev wallet"
            value={qInput}
            onChange={e => setQInput(e.target.value)}
            aria-label="Filter the feed"
            maxLength={120}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="seg" role="group" aria-label="Type" id="fType">
          {TYPES.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={f.type === k} onClick={() => setF(prev => ({ ...prev, type: k }))}>
              {l}
            </button>
          ))}
        </div>
        <select className="sel" id="fNar" aria-label="Narrative verdict" value={f.nar} onChange={e => setF(prev => ({ ...prev, nar: e.target.value as Filters['nar'] }))}>
          <option value="any">Any narrative</option>
          {NAR_BANDS.map(b => (
            <option key={b.key} value={b.key}>
              {b.name}
            </option>
          ))}
        </select>
        <select className="sel" id="fCoin" aria-label="Coin verdict" value={f.coin} onChange={e => setF(prev => ({ ...prev, coin: e.target.value as Filters['coin'] }))}>
          <option value="any">Any coin</option>
          {COIN_BANDS.map(b => (
            <option key={b.key} value={b.key}>
              {b.name}
            </option>
          ))}
        </select>
        <select className="sel" id="fChain" aria-label="Chain" value={f.chain} onChange={e => setF(prev => ({ ...prev, chain: e.target.value as Filters['chain'] }))}>
          <option value="any">All chains</option>
          {CHAIN_ORDER.map(k => (
            <option key={k} value={k}>
              {CHAINS[k].name}
            </option>
          ))}
        </select>
      </div>
      <div id="rows">{rows}</div>
      <div className="fmore" id="fmore">
        {items.length && !failed ? (
          <>
            <span>
              Showing {items.length} of {Math.max(data?.total ?? 0, items.length)}
            </span>
            {data?.nextCursor ? (
              <button className="btn sm" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
                Show 25 more
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
