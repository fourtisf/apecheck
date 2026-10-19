'use client';
import { fmtPct } from '@apecheck/core';
import { useMe } from './Me';

export interface TokenQuote {
  usd: number;
  /** 24h change in % */
  ch24: number | null;
}

/** $0.00412 style: three significant digits below $1. */
export function fmtTokenPrice(usd: number): string {
  if (!(usd > 0)) return '$0';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const digits = Math.min(12, 2 - Math.floor(Math.log10(usd)));
  return `$${usd.toFixed(digits)}`;
}

/**
 * The header's "$APECHECK $0.00412 +6.1%" (the prototype's markup) from MeDTO.token, or `quote` when given.
 * Hidden while the token isn't live (MeDTO.tokenLive false) and whenever there is no real quote: it never shows a
 * made-up price.
 */
export function TokenPrice({ quote }: { quote?: TokenQuote | null }) {
  const { me } = useMe();
  const q = quote ?? me?.token ?? null;
  if (!me?.tokenLive || !q || !(q.usd > 0)) return null;
  return (
    <span className="tok">
      $APECHECK <b>{fmtTokenPrice(q.usd)}</b>{' '}
      {q.ch24 != null ? <span className={q.ch24 >= 0 ? 'up' : 'dn'}>{fmtPct(q.ch24)}</span> : null}
    </span>
  );
}
