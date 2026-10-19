import { coinBand, narBand } from '@apecheck/core';

export interface MiniMeterProps {
  score: number;
  /** 'nar' uses the narrative bands (n-*), 'coin' the coin bands (k-*) */
  kind?: 'nar' | 'coin';
  /** "Narrative" / "Coin": shown before the band name on phones (.mm-k) */
  label?: string;
}

/** mm(n, band, p, label): band name, score and a thin bar in the band colour. */
export function MiniMeter({ score, kind = 'nar', label }: MiniMeterProps) {
  const b = kind === 'coin' ? coinBand(score) : narBand(score);
  const p = kind === 'coin' ? 'k' : 'n';
  const w = Math.max(0, Math.min(100, score));
  return (
    <span className={`mm ${p}-${b.key}`}>
      <span className="mm-t">
        {label ? <span className="mm-k">{label} · </span> : null}
        {b.name}
      </span>
      <b>{score}</b>
      <span className="mm-bar">
        <i style={{ width: `${w}%` }} />
      </span>
    </span>
  );
}
