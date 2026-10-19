import { feed, insights, live } from '@/lib/api';
import { orNull, serverCall } from '@/lib/server-api';
import { FeedView } from '@/components/feed/FeedView';

// verdicts, live checks and stats change every few seconds: always render fresh
export const dynamic = 'force-dynamic';

export default async function FeedPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const q = typeof searchParams.q === 'string' ? searchParams.q.trim().slice(0, 120) : '';
  const call = serverCall();
  const [initialFeed, initialInsights, initialLive] = await Promise.all([
    orNull(feed({ tab: 'latest', q: q || undefined, limit: 25 }, call)),
    orNull(insights(call)),
    orNull(live(call)),
  ]);
  return <FeedView initialFeed={initialFeed} initialInsights={initialInsights} initialLive={initialLive} initialQ={q} />;
}
