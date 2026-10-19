import { coinBand, fmtPct, narBand } from '@apecheck/core';
import { cssVars } from './css';

/** narB(n): narrative verdict pill, e.g. "Likely real 64". '—' when there is no score. */
export function NarBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="nil">—</span>;
  const b = narBand(score);
  return (
    <span className={`vb n-${b.key}`}>
      {b.name}
      <b>{score}</b>
    </span>
  );
}

/** coinB(n): coin verdict pill, e.g. "Sketchy 41". '—' when no coin is linked or it has no score. */
export function CoinBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="nil">—</span>;
  const b = coinBand(score);
  return (
    <span className={`vb k-${b.key}`}>
      {b.name}
      <b>{score}</b>
    </span>
  );
}

/** pct(p): "+6.1%" in green / "−42%" in red, '—' when unknown. */
export function Pct({ value }: { value: number | null | undefined }) {
  if (value == null || !Number.isFinite(value)) return <span className="nil">—</span>;
  return <span className={value >= 0 ? 'up' : 'dn'}>{fmtPct(value)}</span>;
}

/** The score chip (signature element): total score on its narrative-band colour. */
export function ScoreChip({ score, title = 'Total score' }: { score: number | null | undefined; title?: string }) {
  if (score == null) {
    return (
      <span className="schip" style={cssVars({ '--vc': 'var(--dim)' })} title={title}>
        —
      </span>
    );
  }
  return (
    <span className={`schip n-${narBand(score).key}`} title={title}>
      {score}
    </span>
  );
}
