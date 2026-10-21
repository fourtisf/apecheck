import Link from 'next/link';
import { cap, fmtPct, fmtUsd, otherChainCoinText, short, type CheckReportDTO, type CoinFactsDTO } from '@apecheck/core';
import { VCard } from '../VCard';
import { SinceChart } from './SinceChart';
import { isRunning, noVerdict, notEnough } from './util';

function PriceCard({ r }: { r: CheckReportDTO }) {
  if (isRunning(r)) {
    return (
      <div className="scard">
        <h3>Price since check</h3>
        <p className="sub" style={{ margin: 0 }}>
          Tracking starts when the verdict lands, so you can see later whether it held up.
        </p>
      </div>
    );
  }
  if (noVerdict(r) && (r.market?.since ?? r.since) == null) {
    // tracking starts when a verdict lands: a run that stopped before one has nothing to track (and no "no coin linked")
    return (
      <div className="scard">
        <h3>Price since check</h3>
        <p className="sub" style={{ margin: 0 }}>
          {notEnough(r)
            ? 'No contract on a supported chain was found, so there is no price to track.'
            : 'The check stopped before a verdict, so there is no price to track.'}
        </p>
      </div>
    );
  }
  if (!r.hasCoin && r.otherChain) {
    // a coin on a chain ApeCheck can't read: no price was read (and never "paste its contract": it may be the one pasted)
    return (
      <div className="scard">
        <h3>Price since check</h3>
        <p className="sub" style={{ margin: 0 }}>
          {otherChainCoinText(r.otherChain.chain)}, so there is no price to track.
        </p>
      </div>
    );
  }
  if (!r.hasCoin && r.kind === 'coin') {
    return (
      <div className="scard">
        <h3>Price since check</h3>
        <p className="sub" style={{ margin: 0 }}>
          The contract couldn&apos;t be read during this check, so there is no price to track yet.
        </p>
      </div>
    );
  }
  if (!r.hasCoin) {
    return (
      <div className="scard">
        <h3>Price since check</h3>
        <p className="sub" style={{ margin: '0 0 12px' }}>
          No coin is linked to this {r.kind}. If the project has one, paste its contract to check the coin too.
        </p>
        <Link className="btn sm" href="/">
          Check a contract
        </Link>
      </div>
    );
  }
  const m = r.market;
  const since = m?.since ?? r.since;
  const mc = m?.mc ?? r.mc;
  const ch24 = m?.ch24 ?? null;
  const sub = [mc != null ? `MC ${fmtUsd(mc)}` : null, ch24 != null ? `24h ${fmtPct(ch24)}` : null].filter(Boolean).join(' · ');
  const series = m?.series && m.series.length >= 2 ? m.series : null;
  if (since == null) {
    return (
      <div className="scard">
        <h3>Price since check</h3>
        {sub ? <p className="sc-sub" style={{ marginTop: 0 }}>{sub}</p> : null}
        <p className="sub" style={{ margin: 0 }}>
          {m?.priceAtCheck == null
            ? // nothing to compare against: never promise a chart that can't come
              "There was no price for this coin when it was checked, so there's no change since the check to show."
            : 'No price since the check yet. Tracking started when the verdict landed, so check back to see whether it held up.'}
        </p>
      </div>
    );
  }
  return (
    <div className="scard">
      <h3>Price since check</h3>
      <div className={`sc-big ${since >= 0 ? 'up' : 'dn'}`}>{fmtPct(since)}</div>
      {sub ? <p className="sc-sub">{sub}</p> : null}
      {series ? (
        <>
          <div className="chart" id="sinceChart">
            <SinceChart series={series} since={since} />
          </div>
          <div className="ch-ax">
            <span>At check</span>
            <span>Now</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The deployer wallet (the contract creator) and its history as ApeCheck knows it: the other coins from it that
 * ApeCheck has checked. "All their coins" opens the deployers page on the wallet when there are any.
 */
function DeployerCard({ address, coin }: { address: string; coin: Pick<CoinFactsDTO, 'deployerHistory' | 'deployerText'> }) {
  const total = coin.deployerHistory?.total ?? 0;
  return (
    <div className="scard">
      <h3>
        Deployer
        {total > 0 ? (
          <Link href={`/deployers?focus=${encodeURIComponent(address)}`} prefetch={false}>
            All their coins
          </Link>
        ) : null}
      </h3>
      <p style={{ margin: '0 0 6px' }}>
        <span className="mono" style={{ fontSize: 13 }} title={address}>
          {short(address)}
        </span>
      </p>
      <p className="sub" style={{ margin: 0 }}>
        {coin.deployerText ? `${cap(coin.deployerText)}.` : 'Deployer history not checked.'}
      </p>
    </div>
  );
}

/** repSide(): price since the check, the deployer wallet with its history, and the share card. */
export function Side({ report: r }: { report: CheckReportDTO }) {
  const addr = r.coin?.deployerAddress ?? null;
  return (
    <aside className="rep-side">
      <PriceCard r={r} />
      {addr && r.coin ? <DeployerCard address={addr} coin={r.coin} /> : null}
      {r.status === 'done' && r.narScore != null ? (
        <div className="scard">
          <h3>Share card</h3>
          <p className="sub">What @ApeCheckBot posts when someone tags it</p>
          <VCard item={r} />
        </div>
      ) : null}
    </aside>
  );
}
