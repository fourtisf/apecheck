import Link from 'next/link';
import { REP, cap, coinBand, fmtUsd, short, type CheckReportDTO, type CoinFactsDTO } from '@apecheck/core';
import { cssVars } from '../css';
import { Dot, Facts, Unknown, type FactRow } from './util';

/** scoreBlock(): the coin score with its band and the 5-step meter. */
function ScoreBlock({ n }: { n: number }) {
  const b = coinBand(n);
  return (
    <div className={`sb k-${b.key}`}>
      <span className="sb-l">Coin</span>
      <span className="sb-n">
        {n}
        <small>/100</small>
      </span>
      <span className="vb">{b.name}</span>
      <div className="meter" style={cssVars({ '--s': n })} data-s={n}>
        <i />
        <i />
        <i />
        <i />
        <i />
        <b />
      </div>
      <span className="sb-h">Deployer, bundle, holders, liquidity and authorities</span>
    </div>
  );
}

const r1 = (v: number) => +v.toFixed(1);

/**
 * "Who holds the supply", with tabCoin()'s normalisation: when dev + bundled + top 10 add up to more
 * than 92% (they can overlap), scale them down so "Everyone else" keeps a visible slice.
 */
function Supply({ f }: { f: CoinFactsDTO }) {
  const known = f.devHoldPct != null && f.bundlePct != null && f.top10Pct != null;
  let segs: [string, number | null, string][];
  if (known) {
    let dev = f.devHoldPct!;
    let bun = f.bundlePct!;
    let top = f.top10Pct!;
    const sum = dev + bun + top;
    if (sum > 92) {
      const k = 92 / sum;
      dev *= k;
      bun *= k;
      top *= k;
    }
    dev = r1(dev);
    bun = r1(bun);
    top = r1(top);
    const rest = r1(100 - dev - bun - top);
    segs = [
      ['Dev wallet', dev, 'var(--s-dev)'],
      ['Bundled at launch', bun, 'var(--s-bun)'],
      ['Other top 10', top, 'var(--s-top)'],
      ['Everyone else', rest, 'var(--s-rest)'],
    ];
  } else {
    segs = [
      ['Dev wallet', f.devHoldPct, 'var(--s-dev)'],
      ['Bundled at launch', f.bundlePct, 'var(--s-bun)'],
      ['Other top 10', f.top10Pct, 'var(--s-top)'],
    ];
  }
  return (
    <div className="supply">
      <h4 className="h4">Who holds the supply</h4>
      {known ? (
        <div className="stack" role="img" aria-label={segs.map(s => `${s[0]} ${s[1]}%`).join(', ')}>
          {segs.map(s => (
            <i key={s[0]} style={{ width: `${s[1]}%`, background: s[2] }} data-tip={`${s[0]}: ${s[1]}%`} />
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: '0 0 14px', fontSize: 13.5 }}>
          The full holder split wasn&apos;t available for this coin.
        </p>
      )}
      <ul className="legend">
        {segs.map(s => (
          <li key={s[0]}>
            <i className="sw" style={{ background: s[2] }} />
            {s[0]}
            <b>{s[1] != null ? `${r1(s[1])}%` : <Unknown />}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

function factRows(r: CheckReportDTO, f: CoinFactsDTO): FactRow[] {
  const d = f.deployer;
  const bundled =
    f.bundlePct != null ? (
      <>
        <Dot s={f.sig.bundle} />
        {r1(f.bundlePct)}%{f.bundleWallets != null ? ` in ${f.bundleWallets} wallet${f.bundleWallets === 1 ? '' : 's'}` : ''}
      </>
    ) : (
      <Unknown />
    );
  return [
    [
      'Deployer',
      d ? (
        <>
          <Dot s={f.sig.deployer} />
          <span className="mono">{short(d.address)}</span>
          <small>
            {REP[d.record]}
            {d.fundedFrom ? `, funded from ${d.fundedFrom}` : ''}
          </small>
        </>
      ) : (
        <Unknown />
      ),
      'DevRadar',
    ],
    ['Earlier launches', f.deployerText ? cap(f.deployerText) : <Unknown />, 'DevRadar'],
    ['Bundled at launch', bundled, 'BundleScan'],
    [
      'Top 10 holders',
      f.top10Pct != null ? (
        <>
          <Dot s={f.sig.holders} />
          {r1(f.top10Pct)}%<small>Excludes the liquidity pool</small>
        </>
      ) : (
        <Unknown />
      ),
      'WhaleFlow',
    ],
    [
      'Liquidity',
      f.lpStatus ? (
        <>
          <Dot s={f.sig.lp} />
          {f.lpLabel}
        </>
      ) : (
        <Unknown />
      ),
      'On-chain',
    ],
    [
      'Authorities',
      f.authorities ? (
        <>
          <Dot s={f.sig.authorities} />
          {f.authorities}
        </>
      ) : (
        <Unknown />
      ),
      'On-chain',
    ],
    ['Holders', f.holders != null ? f.holders.toLocaleString('en-US') : <Unknown />, 'On-chain'],
    ['Market cap', r.mc != null ? fmtUsd(r.mc) : <Unknown />, 'DexScreener'],
  ];
}

/** tabCoin(): coin score, who holds the supply, and the on-chain facts with their sources. */
export function CoinTab({ report: r }: { report: CheckReportDTO }) {
  if (!r.hasCoin) {
    return (
      <div className="empty">
        <p>No coin is linked to this {r.kind}. The narrative score covers the claims; paste the contract to score the coin too.</p>
        <Link className="btn sm" href="/">
          Check a contract
        </Link>
      </div>
    );
  }
  const f = r.coin;
  return (
    <>
      <div className="coin-g">
        {r.coinScore != null ? <ScoreBlock n={r.coinScore} /> : null}
        {f ? <Supply f={f} /> : null}
      </div>
      {f ? (
        <Facts rows={factRows(r, f)} />
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          The coin facts weren&apos;t available for this check.
        </p>
      )}
    </>
  );
}
