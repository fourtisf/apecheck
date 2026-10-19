'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { CHAINS, CHAIN_ORDER, COIN_BANDS, type CoinsResponse } from '@apecheck/core';
import { coins } from '@/lib/api';
import { SearchIcon } from '../icons';
import { CoinTable } from './CoinTable';
import { COINS_LIMIT, Q_MAX, coinQuery, type CoinFilters, type CoinTab } from './params';
import { useApiQuery, useSyncUrl } from './useApiQuery';

const TABS: [CoinTab, string][] = [['all', 'All'], ...COIN_BANDS.map(b => [b.key, b.name] as [CoinTab, string])];
const SEARCH_DEBOUNCE_MS = 250;

const fetchCoins = (f: CoinFilters, signal: AbortSignal) => coins({ tab: f.tab, chain: f.chain, q: f.q || undefined, limit: COINS_LIMIT }, { signal });

/** viewCoins() + renderCoinRows(): coin-only table, filtered by coin verdict, chain and a search (all in the URL). */
export function CoinsView({ initial, initialFilters }: { initial: CoinsResponse | null; initialFilters: CoinFilters }) {
  const [f, setF] = useState<CoinFilters>(initialFilters);
  const [qInput, setQInput] = useState(initialFilters.q);

  useEffect(() => {
    const t = window.setTimeout(() => setF(prev => (prev.q === qInput.trim() ? prev : { ...prev, q: qInput.trim() })), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [qInput]);

  useSyncUrl(`/coins${coinQuery(f)}`);

  const { data, failed, retry } = useApiQuery(f, fetchCoins, initial, initialFilters);
  const items = data?.items ?? [];
  const filtered = f.tab !== 'all' || f.chain !== 'any' || f.q !== '';

  let body: ReactNode;
  if (failed) {
    body = (
      <div className="tbl">
        <div className="tbl-empty" style={{ borderTop: 0 }}>
          Couldn&apos;t load coins right now.
          <br />
          <button className="btn sm" type="button" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    );
  } else if (!data) {
    body = null;
  } else if (!items.length) {
    body = (
      <div className="tbl">
        <div className="tbl-empty" style={{ borderTop: 0 }}>
          {filtered ? 'No coins match these filters.' : 'No coins have been checked yet. Paste a contract address on the feed to run the first check.'}
        </div>
      </div>
    );
  } else {
    body = <CoinTable items={items} />;
  }

  return (
    <section className="wrap page">
      <div className="ph">
        <div>
          <h1 className="h-pg">Coins</h1>
          <p>
            The coin score looks only at the token: who deployed it, how much was bundled, who holds the supply and whether liquidity can be pulled.
            It&apos;s separate from whether the story is real.
          </p>
        </div>
      </div>
      <div className="fbar">
        <div className="seg" role="group" aria-label="Coin verdict" id="cTab">
          {TABS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={f.tab === k} onClick={() => setF(prev => ({ ...prev, tab: k }))}>
              {l}
            </button>
          ))}
        </div>
        <label className="fsearch">
          <SearchIcon />
          <input
            id="cq"
            placeholder="Search $ticker, CA or deployer"
            value={qInput}
            onChange={e => setQInput(e.target.value)}
            aria-label="Filter coins"
            maxLength={Q_MAX}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <select
          className="sel"
          id="cChain"
          aria-label="Chain"
          value={f.chain}
          onChange={e => setF(prev => ({ ...prev, chain: e.target.value as CoinFilters['chain'] }))}
        >
          <option value="any">All chains</option>
          {CHAIN_ORDER.map(k => (
            <option key={k} value={k}>
              {CHAINS[k].name}
            </option>
          ))}
        </select>
      </div>
      <div id="cRows">{body}</div>
      {data && !failed && data.total > items.length ? (
        <div className="fmore">
          <span>
            Showing {items.length} of {data.total}. Search or pick a verdict to narrow it down.
          </span>
        </div>
      ) : null}
    </section>
  );
}
