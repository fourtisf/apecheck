export interface RingProps {
  /** 0–100, how much of the ring is filled */
  value: number;
  size: number;
  /** stroke colour; defaults to the band colour var(--vc) of the parent (.n-real etc.) */
  color?: string;
  /** id on the arc circle (the report animates #rvTot / #rvArc) */
  id?: string;
}

/**
 * ringSVG(n, size, col, id): track + arc, starting at 12 o'clock. Changing `value` animates through the
 * prototype's `.rv-ring svg .arc` transition. Wrap it in `.rv-ring` with a `.rv-ring-in` label, like the prototype.
 */
export function Ring({ value, size, color, id }: RingProps) {
  const c = size / 2;
  const r = c - 7;
  const C = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={c} cy={c} r={r} fill="none" style={{ stroke: 'var(--panel2)' }} strokeWidth="9" />
      <circle
        className="arc"
        id={id}
        data-c={C.toFixed(1)}
        cx={c}
        cy={c}
        r={r}
        fill="none"
        style={{ stroke: color || 'var(--vc)' }}
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${((C * v) / 100).toFixed(1)} ${C.toFixed(1)}`}
        transform={`rotate(-90 ${c} ${c})`}
      />
    </svg>
  );
}
