/** spark(a, w, h): since-check sparkline with a dashed zero line; green if it ends up, red if down. */
export function Spark({ data, w = 46, h = 16 }: { data: number[] | null | undefined; w?: number; h?: number }) {
  if (!data || data.length < 2) return null;
  const mn = Math.min(0, ...data);
  const mx = Math.max(0, ...data);
  const rg = mx - mn || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - mn) / rg) * (h - 2)).toFixed(1)}`).join(' ');
  const z = (h - 1 - ((0 - mn) / rg) * (h - 2)).toFixed(1);
  const col = data[data.length - 1] >= 0 ? 'var(--up)' : 'var(--dn)';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <line x1="0" x2={w} y1={z} y2={z} style={{ stroke: 'var(--line2)' }} strokeDasharray="2 2" />
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
