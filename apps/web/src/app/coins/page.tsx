import type { Metadata } from 'next';
import { coins } from '@/lib/api';
import { orNull, serverCall } from '@/lib/server-api';
import { CoinsView } from '@/components/pages/CoinsView';
import { COINS_LIMIT, parseCoinFilters, type SearchParams } from '@/components/pages/params';

export const metadata: Metadata = {
  title: 'Coins',
  description: 'Every checked coin with its coin score: deployer record, bundled supply, top holders, liquidity and authorities.',
};

// verdicts land and prices move all the time
export const dynamic = 'force-dynamic';

export default async function CoinsPage({ searchParams }: { searchParams: SearchParams }) {
  const f = parseCoinFilters(searchParams);
  const data = await orNull(coins({ tab: f.tab, chain: f.chain, q: f.q || undefined, limit: COINS_LIMIT }, serverCall()));
  // a new key remounts the view when a link changes the filters while the page is open
  return <CoinsView key={`${f.tab}|${f.chain}|${f.q}`} initial={data} initialFilters={f} />;
}
