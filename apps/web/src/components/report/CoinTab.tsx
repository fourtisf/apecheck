import Link from 'next/link';
import { cap, coinBand, fmtUsd, otherChainCoinText, short, type CheckReportDTO, type CoinFactsDTO } from '@apecheck/core';
import { cssVars } from '../css';
import { Dot, Facts, NotChecked, Unknown, noVerdict, notEnough, type FactRow } from './util';

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
          The full holder split was not checked for this coin.
        </p>
      )}
      <ul className="legend">
        {segs.map(s => (
          <li key={s[0]}>
            <i className="sw" style={{ background: s[2] }} />
            {s[0]}
            <b>{s[1] != null ? `${r1(s[1])}%` : <NotChecked />}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The coin facts with their sources: ApeCheck's own reads only. "On-chain" for what the chain says (the deployer wallet,
 * Solana's largest holders, authorities), "ApeCheck" for the other coins from the deployer that ApeCheck has checked.
 * A fact with no source, or none this time, reads "Not checked" with no source tag; a value older checks stored stays
 * shown, untagged.
 */
function factRows(r: CheckReportDTO, f: CoinFactsDTO): FactRow[] {
  const addr = f.deployerAddress ?? null;
  const bundled =
    f.bundlePct != null ? (
      <>
        <Dot s={f.sig.bundle} />
        {r1(f.bundlePct)}%{f.bundleWallets != null ? ` in ${f.bundleWallets} wallet${f.bundleWallets === 1 ? '' : 's'}` : ''}
      </>
    ) : (
      <NotChecked />
    );
  return [
    [
      'Deployer',
      addr ? (
        <span className="mono" title={addr}>
          {short(addr)}
        </span>
      ) : (
        <NotChecked />
      ),
      addr ? 'On-chain' : '',
    ],
    ['Deployer history', f.deployerText ? cap(f.deployerText) : <NotChecked />, f.deployerText ? 'ApeCheck' : ''],
    ['Bundled at launch', bundled, ''],
    [
      'Top 10 holders',
      f.top10Pct != null ? (
        <>
          <Dot s={f.sig.holders} />
          {r1(f.top10Pct)}%<small>Excludes the liquidity pool</small>
        </>
      ) : (
        <NotChecked />
      ),
      // Solana's largest token accounts, read over RPC (no other chain has a holder source)
      f.top10Pct != null && r.chain === 'sol' ? 'On-chain' : '',
    ],
    [
      'Liquidity',
      f.lpStatus ? (
        <>
          <Dot s={f.sig.lp} />
          {f.lpLabel}
        </>
      ) : (
        <NotChecked />
      ),
      '',
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
    ['Holders', f.holders != null ? f.holders.toLocaleString('en-US') : <NotChecked />, ''],
    ['Market cap', r.mc != null ? fmtUsd(r.mc) : <Unknown />, 'DexScreener'],
  ];
}

/** tabCoin(): coin score, who holds the supply, and the on-chain facts with their sources. */
export function CoinTab({ report: r }: { report: CheckReportDTO }) {
  if (!r.hasCoin && notEnough(r)) {
    // nothing to test, the coin included: "Not enough to check" means no contract on a supported chain was found
    return (
      <div className="empty">
        <p>No contract on a supported chain was found, so there is no coin score. The Agent run tab shows what was looked for.</p>
      </div>
    );
  }
  if (!r.hasCoin && noVerdict(r)) {
    // the run stopped before it got to the coin: neither "no coin linked" nor "couldn't be read" is known
    return (
      <div className="empty">
        <p>The check stopped before the coin was looked at, so there is no coin score. The Agent run tab shows how far it got; re-check to try again.</p>
      </div>
    );
  }
  if (!r.hasCoin && r.otherChain) {
    // the coin trades only on a chain ApeCheck has no on-chain reads for: named, never "no coin linked" or "paste it"
    const o = r.otherChain;
    return (
      <div className="empty">
        <p>{otherChainCoinText(o.chain)}, so this check has no coin facts and no coin score.</p>
        <p className="muted" style={{ margin: 0 }}>
          Contract on {o.chain}:{' '}
          <span className="mono" title={o.address}>
            {short(o.address)}
          </span>
        </p>
      </div>
    );
  }
  if (!r.hasCoin && r.kind === 'coin') {
    // a pasted contract whose chain couldn't be established (RPCs and DexScreener unreachable, or no code anywhere)
    return (
      <div className="empty">
        <p>The contract couldn&apos;t be read on a supported chain during this check, so there is no coin score. The Agent run tab shows what was tried.</p>
      </div>
    );
  }
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
          The coin facts were not checked for this coin.
        </p>
      )}
    </>
  );
}
