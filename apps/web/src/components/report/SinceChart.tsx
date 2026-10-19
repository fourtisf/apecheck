'use client';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { clamp, fmtPct, type MarketDTO } from '@apecheck/core';
import { useTooltip } from '../Tooltip';

const SW = 300;
const SH = 120;
const SP = 6;

function whenText(i: number, series: NonNullable<MarketDTO['series']>): string {
  if (i === 0) return 'At check';
  const m = Math.max(0, (Date.parse(series[i].t) - Date.parse(series[0].t)) / 60000);
  if (m < 60) return `${Math.round(m)}m after check`;
  if (m < 48 * 60) return `${(m / 60).toFixed(1)}h after check`;
  return `${(m / 1440).toFixed(1)}d after check`;
}

/** sinceSVG() + bindChart(): % change since the check, with a hover crosshair and tooltip. */
export function SinceChart({ series, since }: { series: NonNullable<MarketDTO['series']>; since: number }) {
  const { show, hide } = useTooltip();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => hide, [hide]);

  const a = series.map(p => p.pct);
  const n = a.length;
  const mn = Math.min(-5, ...a);
  const mx = Math.max(5, ...a);
  const rg = mx - mn || 1;
  const X = (i: number) => SP + (i / (n - 1)) * (SW - 2 * SP);
  const Y = (v: number) => SP + ((mx - v) / rg) * (SH - 2 * SP);
  const line = a.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const col = since >= 0 ? 'var(--up)' : 'var(--dn)';
  const area = `${line}L${X(n - 1).toFixed(1)},${Y(0).toFixed(1)}L${X(0).toFixed(1)},${Y(0).toFixed(1)}Z`;

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * SW;
    const i = clamp(Math.round(((x - SP) / (SW - 2 * SP)) * (n - 1)), 0, n - 1);
    setHover(i);
    show(
      <>
        <span>{whenText(i, series)}</span>
        {'  '}
        <b className={a[i] >= 0 ? 'up' : 'dn'}>{fmtPct(a[i])}</b>
      </>,
      r.left + (X(i) / SW) * r.width,
      r.top + (Y(a[i]) / SH) * r.height,
    );
  };
  const leave = () => {
    setHover(null);
    hide();
  };

  const hx = hover != null ? X(hover) : 0;
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${SW} ${SH}`}
      role="img"
      aria-label={`Price change since the check, now ${fmtPct(since)}`}
      onPointerMove={move}
      onPointerLeave={leave}
    >
      <line x1={SP} x2={SW - SP} y1={Y(0)} y2={Y(0)} style={{ stroke: 'var(--line2)' }} strokeDasharray="3 3" />
      <path d={area} fill={col} opacity=".1" />
      <path d={line} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={X(0)} cy={Y(0)} r="4" fill="var(--panel)" stroke="var(--ink)" strokeWidth="2" />
      <circle cx={X(n - 1)} cy={Y(a[n - 1])} r="4" fill={col} stroke="var(--panel)" strokeWidth="2" />
      <line x1={hx} x2={hx} y1={SP} y2={SH - SP} style={{ stroke: 'var(--dim)' }} strokeWidth="1" opacity={hover != null ? 0.6 : 0} />
      <circle
        cx={hx}
        cy={hover != null ? Y(a[hover]) : 0}
        r="4.5"
        fill={col}
        stroke="var(--panel)"
        strokeWidth="2"
        opacity={hover != null ? 1 : 0}
      />
      <rect x="0" y="0" width={SW} height={SH} fill="transparent" />
    </svg>
  );
}
