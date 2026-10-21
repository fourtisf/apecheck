'use client';
import Link from 'next/link';
import { CHAINS, TUNING, fmtPct, short, type InsightsDTO } from '@apecheck/core';
import { reportPath } from '@/lib/env';
import { Avatar } from '../Avatar';
import { NarBadge } from '../Badges';

function SinceByVerdict({ rows }: { rows: InsightsDTO['sinceByVerdict'] }) {
  const groups = rows.filter(g => g.n > 0 && Number.isFinite(g.avg));
  const mx = Math.max(0, ...groups.map(g => Math.abs(g.avg))) || 1;
  return (
    <div className="scard">
      <h3>Since check, by verdict</h3>
      <p className="sub">Average price move of checked coins after they were stamped</p>
      {groups.length ? (
        <>
          <div className="dv">
            {groups.map(g => (
              <div key={g.key} className={`dv-row n-${g.key}`} data-tip={`${g.name}: ${g.n} coin${g.n === 1 ? '' : 's'}, average ${fmtPct(g.avg)}`}>
                <span className="dv-l">
                  <i className="sw" />
                  {g.name}
                </span>
                <span className="dv-bar">
                  <i
                    className={g.avg >= 0 ? 'pos' : 'neg'}
                    style={g.avg >= 0 ? { left: '50%', width: `${((Math.abs(g.avg) / mx) * 50).toFixed(1)}%` } : { right: '50%', width: `${((Math.abs(g.avg) / mx) * 50).toFixed(1)}%` }}
                  />
                </span>
                <span className={`dv-v ${g.avg >= 0 ? 'up' : 'dn'}`}>{fmtPct(g.avg)}</span>
              </div>
            ))}
          </div>
          <div className="dv-ax">
            <span>−{Math.round(mx)}%</span>
            <span>0</span>
            <span>+{Math.round(mx)}%</span>
          </div>
        </>
      ) : (
        <p className="s-empty">No checked coins with price data from the last {TUNING.sinceWindowDays} days yet.</p>
      )}
    </div>
  );
}

function MostChecked({ items, onAll }: { items: InsightsDTO['mostChecked']; onAll: () => void }) {
  return (
    <div className="scard">
      <h3>
        Most checked <small>today</small>
        <button type="button" onClick={onAll}>
          All
        </button>
      </h3>
      {items.length ? (
        <ol className="rk">
          {items.map((it, i) => (
            <li key={it.id}>
              <Link href={reportPath(it.id)} prefetch={false}>
                <span className="rk-i">{i + 1}</span>
                <Avatar item={it} size={22} />
                <b>{it.name}</b>
                <NarBadge score={it.narScore} />
                <span className="rk-n">{it.checksToday}</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="s-empty">Nothing has been checked today yet.</p>
      )}
    </div>
  );
}

function Builders({ items }: { items: InsightsDTO['builders'] }) {
  return (
    <div className="scard">
      <h3>
        Builders worth watching<Link href="/deployers">All</Link>
      </h3>
      {items.length ? (
        <ul className="dl">
          {items.map(d => (
            <li key={`${d.chain}:${d.address}`}>
              <Link href={`/deployers?focus=${encodeURIComponent(d.address)}`} prefetch={false}>
                <span className="mono">{short(d.address)}</span>
                <small>
                  {d.real} of {d.checked} checked coins real · {CHAINS[d.chain]?.name ?? d.chain}
                </small>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="s-empty">No deployer has a coin that checked real yet.</p>
      )}
    </div>
  );
}

/** renderSide(): the three insight cards under the hero. Each card stays put with a short line when it has no data. */
export function Insights({ data, onMostCheckedAll }: { data: InsightsDTO | null; onMostCheckedAll: () => void }) {
  return (
    <div className="side" id="side" aria-label="Highlights">
      <SinceByVerdict rows={data?.sinceByVerdict ?? []} />
      <MostChecked items={data?.mostChecked ?? []} onAll={onMostCheckedAll} />
      <Builders items={data?.builders ?? []} />
    </div>
  );
}
