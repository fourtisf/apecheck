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
 * The header's "$APECHECK $0.00412 +6.1%". Hidden while the token isn't live (MeDTO.tokenLive false)
 * and whenever no real quote is passed in: it never shows a made-up price. MeDTO has no quote yet,
 * so the header renders nothing until the API provides one.
 */
export function TokenPrice({ quote }: { quote?: TokenQuote | null }) {
  const { me } = useMe();
  if (!me?.tokenLive || !quote) return null;
  return (
    <span className="tok">
      $APECHECK <b>{fmtTokenPrice(quote.usd)}</b>{' '}
      {quote.ch24 != null ? <span className={quote.ch24 >= 0 ? 'up' : 'dn'}>{fmtPct(quote.ch24)}</span> : null}
    </span>
  );
}
