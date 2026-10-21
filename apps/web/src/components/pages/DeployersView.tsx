'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CHAINS, REP, cap, fmtAge, short, type ChainKey, type DeployerRowDTO, type DeployersResponse } from '@apecheck/core';
import { deployers } from '@/lib/api';
import { reportPath } from '@/lib/env';
import { Avatar } from '../Avatar';
import { CoinBadge } from '../Badges';
import { ChainTag } from '../ChainTag';
import { DEPLOYERS_LIMIT, deployerQuery, parseDeployerFilters, sameAddress, sameDeployerList, type DeployerFilters, type DeployerSort } from './params';
import { useApiQuery, useSyncUrl, useUrlSearchParams } from './useApiQuery';

const CHAIN_SEG: [ChainKey | 'all', string][] = [
  ['all', 'All chains'],
  ['sol', 'Solana'],
  ['rh', 'Robinhood'],
  ['base', 'Base'],
  ['bnb', 'BNB'],
];
const SORTS: [DeployerSort, string][] = [
  ['real', 'Most real first'],
  ['dead', 'Most dead tokens first'],
  ['launched', 'Most launches first'],
];
/** .dep-focus plays a 3 s highlight */
const FOCUS_MS = 3000;

type ListParams = Pick<DeployerFilters, 'chain' | 'sort'>;
const fetchDeployers = (p: ListParams, signal: AbortSignal) => deployers({ chain: p.chain, sort: p.sort, limit: DEPLOYERS_LIMIT }, { signal });

/** One deployer can launch on several EVM chains with the same address, so rows are keyed by both. */
const rowKey = (d: Pick<DeployerRowDTO, 'chain' | 'address'>) => `${d.chain}:${d.address}`;
const rowId = (d: Pick<DeployerRowDTO, 'chain' | 'address'>) => `dep-${d.chain}-${d.address}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const focusRow = (data: DeployersResponse | null, address: string | null) =>
  address ? data?.items.find(d => sameAddress(d.address, address)) : undefined;

function DeployerRow({ d, i, open, focus, onToggle }: { d: DeployerRowDTO; i: number; open: boolean; focus: boolean; onToggle: () => void }) {
  const age = fmtAge(d.firstSeen);
  const moreId = `${rowId(d)}-more`;
  return (
    <div className={`dep${focus ? ' dep-focus' : ''}`} id={rowId(d)}>
      <button type="button" className="tr dep-row" aria-expanded={open} aria-controls={moreId} onClick={onToggle}>
        <span className="num muted" style={{ textAlign: 'left' }}>
          {i + 1}
        </span>
        <span className="td c-nm">
          <span className="nm">
            <span className="nm1">
              <b className="mono" style={{ fontSize: '13.5px' }} title={d.address}>
                {short(d.address)}
              </b>
            </span>
            <span className="nm2">First seen {age ? `${age} ago` : '—'}</span>
          </span>
        </span>
        <span className="td c-ch">
          <ChainTag chain={d.chain} />
        </span>
        <span className="td c-sc">
          <span className={`rep-b r-${d.record}`}>{REP[d.record]}</span>
        </span>
        <span className="td num">{d.launched}</span>
        <span className={`td num${d.dead ? ' dn' : ''}`}>{d.dead}</span>
        <span className="td num">{d.checked}</span>
        <span className="td num">{d.checked ? `${d.real}/${d.checked}` : <span className="nil">—</span>}</span>
        <span className="td num c-avg">{d.avgTotal != null ? d.avgTotal : <span className="nil">—</span>}</span>
        <span className="td c-fund" style={{ fontSize: '13.5px', color: 'var(--mute)' }}>
          {d.fundedFrom ? cap(d.fundedFrom) : <span className="nil">—</span>}
        </span>
        <span className="c-mob">
          <span>{d.launched} launched</span>
          <span className={d.dead ? 'dn' : ''}>{d.dead} dead</span>
          <span>{d.checked} checked</span>
          <span>{CHAINS[d.chain]?.name}</span>
        </span>
      </button>
      <div className="dep-more" id={moreId} hidden={!open}>
        <p>
          {d.fundedFrom ? `Funded from ${d.fundedFrom}. ` : ''}
          {plural(d.launched, 'token')} launched, {d.dead} dead.{' '}
          {d.coins.length ? 'Checked coins from this wallet:' : 'None of their coins have been checked yet.'}
        </p>
        {d.coins.length ? (
          <div className="chips">
            {d.coins.map(c => (
              <Link key={c.id} className="chip-l" href={reportPath(c.id)} prefetch={false}>
                <Avatar item={{ kind: 'coin', hue: c.hue, ticker: c.ticker, name: c.name }} size={20} />
                <b>{c.ticker ? `$${c.ticker}` : c.name}</b>
                <CoinBadge score={c.coinScore} />
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * viewDeployers() + renderDepRows(): every wallet that launched a checked coin. Chain and sort live in the URL;
 * ?focus=<address> opens that row, scrolls to it and flashes it (links from "Builders worth watching").
 */
export function DeployersView({ initial, initialFilters }: { initial: DeployersResponse | null; initialFilters: DeployerFilters }) {
  // start from the address bar, not the props: after Back they can describe an older URL (see useUrlSearchParams)
  const url = useUrlSearchParams();
  const [start] = useState(() => parseDeployerFilters(url));
  // the server's rows only fit the chain and sort they were rendered for
  const startData = sameDeployerList(start, initialFilters) ? initial : null;
  const [chain, setChain] = useState(start.chain);
  const [sort, setSort] = useState(start.sort);
  // a ?focus= row that is already in the server render opens (and starts its highlight) before hydration
  const [open, setOpen] = useState<string | null>(() => {
    const row = focusRow(startData, start.focus);
    return row ? rowKey(row) : null;
  });
  const [flash, setFlash] = useState<string | null>(open);
  const [pendingFocus, setPendingFocus] = useState(start.focus);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(t => window.clearTimeout(t)), []);

  const { data, failed, retry } = useApiQuery<ListParams, DeployersResponse>(
    { chain, sort },
    fetchDeployers,
    startData,
    { chain: initialFilters.chain, sort: initialFilters.sort },
  );
  const items = data?.items ?? [];

  // the open row is part of the link, so a shared URL opens the same wallet
  const openRow = open ? items.find(d => rowKey(d) === open) : undefined;
  useSyncUrl(`/deployers${deployerQuery({ chain, sort, focus: openRow?.address ?? pendingFocus })}`);

  // ?focus=<address>: open the row once it's in the list, centre it and play the highlight
  useEffect(() => {
    if (!pendingFocus || !data) return;
    setPendingFocus(null);
    const row = focusRow(data, pendingFocus);
    if (!row) return;
    const k = rowKey(row);
    setOpen(k);
    setFlash(k);
    timers.current.push(
      window.setTimeout(() => document.getElementById(rowId(row))?.scrollIntoView({ block: 'center' }), 30),
      window.setTimeout(() => setFlash(f => (f === k ? null : f)), FOCUS_MS + 100),
    );
  }, [data, pendingFocus]);

  let body: ReactNode = null;
  if (failed) {
    body = (
      <div className="tbl">
        <div className="tbl-empty" style={{ borderTop: 0 }}>
          Couldn&apos;t load deployers right now.
          <br />
          <button className="btn sm" type="button" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    );
  } else if (data && !items.length) {
    body = (
      <div className="tbl">
        <div className="tbl-empty" style={{ borderTop: 0 }}>
          {chain !== 'all' && CHAINS[chain]
            ? `No deployers on ${CHAINS[chain].name} yet.`
            : 'No deployers yet. Every wallet that launches a checked coin shows up here.'}
        </div>
      </div>
    );
  } else if (items.length) {
    body = (
      <div className="tbl dtbl">
        <div className="tr th">
          <span>#</span>
          <span>Wallet</span>
          <span className="c-ch">Chain</span>
          <span>Record</span>
          <span className="num">Launched</span>
          <span className="num">Dead</span>
          <span className="num">Checked</span>
          <span className="num">Real</span>
          <span className="num c-avg">Avg total</span>
          <span className="c-fund">Funded from</span>
        </div>
        {items.map((d, i) => {
          const k = rowKey(d);
          return <DeployerRow key={k} d={d} i={i} open={open === k} focus={flash === k} onToggle={() => setOpen(o => (o === k ? null : k))} />;
        })}
      </div>
    );
  }

  return (
    <section className="wrap page">
      <div className="ph">
        <div>
          <h1 className="h-pg">Deployers</h1>
          <p>
            Every wallet that launched a checked coin, with every coin from it that ApeCheck has checked. Builders ship more than once; serial launchers leave a
            trail of dead tokens.
          </p>
        </div>
      </div>
      <div className="fbar">
        <div className="seg" role="group" aria-label="Chain" id="dChain">
          {CHAIN_SEG.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={chain === k} onClick={() => setChain(k)}>
              {l}
            </button>
          ))}
        </div>
        <select className="sel" id="dSort" aria-label="Sort" value={sort} onChange={e => setSort(e.target.value as DeployerSort)}>
          {SORTS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div id="dRows">{body}</div>
    </section>
  );
}
