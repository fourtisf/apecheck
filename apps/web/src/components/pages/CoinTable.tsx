import Link from 'next/link';
import type { ReactNode } from 'react';
import { REP, fmtUsd, short, type CoinRowDTO, type Signal } from '@apecheck/core';
import { reportPath } from '@/lib/env';
import { Avatar } from '../Avatar';
import { CoinBadge, Pct } from '../Badges';
import { ChainTag } from '../ChainTag';
import { Spark } from '../Spark';

/** 3.2 → "3.2%", 2 → "2%" (the prototype keeps one decimal and drops a trailing zero) */
const pctText = (n: number) => `${+n.toFixed(1)}%`;
const nil = <span className="nil">—</span>;

/** A value with its signal dot, or a muted dash when the source didn't report it. */
function Dotted({ sig, children }: { sig: Signal; children: ReactNode }) {
  return (
    <>
      <span className={`dot ${sig}`} />
      {children}
    </>
  );
}

/** "$ORBIT"; a coin linked from a site or post without a known ticker shows its short contract address */
const tickerOf = (it: CoinRowDTO) => (it.ticker ? `$${it.ticker}` : it.kind === 'coin' || !it.ca ? it.name : short(it.ca));

/** One coin in the coins table (renderCoinRows). Unknown facts show a muted "—". */
export function CoinRow({ item: it }: { item: CoinRowDTO }) {
  const f = it.facts;
  const lp = f.lpLabel && f.lpLabel !== 'Unknown' ? f.lpLabel : null;
  const mob = [
    f.bundlePct != null ? `Bundled ${pctText(f.bundlePct)}` : null,
    f.top10Pct != null ? `Top 10 ${pctText(f.top10Pct)}` : null,
    lp,
    it.mc ? `MC ${fmtUsd(it.mc)}` : null,
  ].filter((s): s is string => !!s);
  return (
    <Link className="tr" href={reportPath(it.id)} prefetch={false}>
      <span className="td c-nm">
        <Avatar item={{ kind: 'coin', hue: it.hue, ticker: it.ticker, name: it.name }} />
        <span className="nm">
          <span className="nm1">
            <b>{tickerOf(it)}</b>
            <ChainTag chain={it.chain} />
          </span>
          <span className="nm2">
            {it.kind === 'coin' ? (
              <>Narrative {it.narScore ?? '—'}</>
            ) : (
              <>Linked from {it.name}</>
            )}
          </span>
        </span>
      </span>
      <span className="td c-sc">
        <CoinBadge score={it.coinScore} />
      </span>
      <span className="td num">{f.bundlePct != null ? <Dotted sig={f.sig.bundle}>{pctText(f.bundlePct)}</Dotted> : nil}</span>
      <span className="td num">{f.top10Pct != null ? <Dotted sig={f.sig.holders}>{pctText(f.top10Pct)}</Dotted> : nil}</span>
      <span className="td num c-dev">{f.devHoldPct != null ? pctText(f.devHoldPct) : nil}</span>
      <span className="td">{lp ? <Dotted sig={f.sig.lp}>{lp}</Dotted> : nil}</span>
      <span className="td c-mint" style={{ fontSize: '13.5px' }}>
        {f.authorities ? <Dotted sig={f.sig.authorities}>{f.authorities}</Dotted> : nil}
      </span>
      <span className="td">
        {f.deployerRecord ? (
          <span className={`rep-b r-${f.deployerRecord}`}>{REP[f.deployerRecord]}</span>
        ) : f.deployerAddress ? (
          // wallet known, launch history not: show the address, never a made-up record
          <span title={f.deployerAddress} style={{ display: 'grid', gap: 2, minWidth: 0 }}>
            <span className="mono" style={{ fontSize: 13 }}>
              {short(f.deployerAddress)}
            </span>
            <small style={{ fontSize: 12, lineHeight: 1.3, color: 'var(--mute)' }}>Launch history not checked</small>
          </span>
        ) : (
          nil
        )}
      </span>
      <span className="td num">{it.mc ? fmtUsd(it.mc) : nil}</span>
      <span className="td num c-since">
        <Spark data={it.spark} />
        <Pct value={it.since} />
      </span>
      <span className="c-mob">
        {mob.map(s => (
          <span key={s}>{s}</span>
        ))}
      </span>
    </Link>
  );
}

/** The coins table: header + rows (`.tbl.ctbl`). */
export function CoinTable({ items }: { items: CoinRowDTO[] }) {
  return (
    <div className="tbl ctbl">
      <div className="tr th">
        <span>Coin</span>
        <span>Coin score</span>
        <span className="num">Bundled</span>
        <span className="num">Top 10</span>
        <span className="num c-dev">Dev</span>
        <span>Liquidity</span>
        <span className="c-mint">Authorities</span>
        <span>Deployer</span>
        <span className="num">MC</span>
        <span className="num">Since check</span>
      </div>
      {items.map(it => (
        <CoinRow key={it.id} item={it} />
      ))}
    </div>
  );
}
