import Link from 'next/link';
import { REP, fmtAge, fmtPct, fmtUsd, short, type CheckReportDTO, type DeployerDTO } from '@apecheck/core';
import { VCard } from '../VCard';
import { SinceChart } from './SinceChart';
import { isRunning } from './util';

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
          No price since the check yet. Tracking started when the verdict landed, so check back to see whether it held up.
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

function DeployerCard({ d }: { d: DeployerDTO }) {
  const age = fmtAge(d.firstSeen);
  const line = [
    d.fundedFrom ? `Funded from ${d.fundedFrom}.` : null,
    `${d.launched} token${d.launched === 1 ? '' : 's'} launched, ${d.dead} dead.`,
    age ? `Wallet first seen ${age} ago.` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={`scard r-${d.record}`}>
      <h3>
        Deployer
        <Link href={`/deployers?focus=${encodeURIComponent(d.address)}`} prefetch={false}>
          All their coins
        </Link>
      </h3>
      <p style={{ margin: '0 0 6px' }}>
        <span className="mono" style={{ fontSize: 13 }} title={d.address}>
          {short(d.address)}
        </span>
        {'  '}
        <span className="rep-b">{REP[d.record]}</span>
      </p>
      <p className="sub" style={{ margin: 0 }}>
        {line}
      </p>
    </div>
  );
}

/** repSide(): price since the check, the deployer's record and the share card. */
export function Side({ report: r }: { report: CheckReportDTO }) {
  const d = r.coin?.deployer ?? null;
  return (
    <aside className="rep-side">
      <PriceCard r={r} />
      {d ? <DeployerCard d={d} /> : null}
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
