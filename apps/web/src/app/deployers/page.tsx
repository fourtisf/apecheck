import type { Metadata } from 'next';
import { deployers } from '@/lib/api';
import { orNull, serverCall } from '@/lib/server-api';
import { DeployersView } from '@/components/pages/DeployersView';
import { DEPLOYERS_LIMIT, parseDeployerFilters, type SearchParams } from '@/components/pages/params';

export const metadata: Metadata = {
  title: 'Deployers',
  description: 'Every wallet that deployed a coin ApeCheck has checked, and how its checked coins scored. Only coins checked on ApeCheck are counted.',
};

export const dynamic = 'force-dynamic';

export default async function DeployersPage({ searchParams }: { searchParams: SearchParams }) {
  const f = parseDeployerFilters(searchParams);
  const data = await orNull(deployers({ chain: f.chain, sort: f.sort, limit: DEPLOYERS_LIMIT }, serverCall()));
  // a link that changes the filters while the page is open remounts the view (and plays a new ?focus=)
  return <DeployersView key={`${f.chain}|${f.sort}|${f.focus ?? ''}`} initial={data} initialFilters={f} />;
}
