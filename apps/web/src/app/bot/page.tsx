import type { Metadata } from 'next';
import type { CheckSummaryDTO, FeedResponse } from '@apecheck/core';
import { botStats, feed, report, type CallOpts } from '@/lib/api';
import { orNull, serverCall } from '@/lib/server-api';
import { BotView, type BotViewProps } from '@/components/pages/BotView';

export const metadata: Metadata = {
  title: 'X bot',
  description: 'Tag the ApeCheck bot under any project post on X. It runs the full check and replies in the thread with the verdict and a share card.',
};

export const dynamic = 'force-dynamic';

/** "Recent bot replies", like the prototype */
const RECENT = 8;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** The bot's X handle without "@": NEXT_PUBLIC_BOT_HANDLE, else X_BOT_HANDLE from the repo-root .env. */
function botHandle(): string {
  const h = (process.env.NEXT_PUBLIC_BOT_HANDLE || process.env.X_BOT_HANDLE || '').trim().replace(/^@+/, '');
  return HANDLE_RE.test(h) ? h : 'ApeCheckBot';
}

/** The most recent finished post check, a bot one when there is one, with the post text the check read. */
async function exampleThread(recent: FeedResponse | null, call: CallOpts): Promise<BotViewProps['example']> {
  if (!recent) return null; // API down or limiting us: don't stack three more slow calls
  let item: CheckSummaryDTO | undefined = recent.items.find(i => i.kind === 'post');
  // a short list already holds every bot reply, so only look further back when it is full
  if (!item && recent.items.length >= RECENT) item = (await orNull(feed({ type: 'post', via: 'bot', limit: 1 }, call)))?.items[0];
  if (!item) item = (await orNull(feed({ type: 'post', limit: 1 }, call)))?.items[0];
  if (!item) return null;
  const full = await orNull(report(item.id, call));
  return { item: full ?? item, post: full?.post ?? null };
}

export default async function BotPage() {
  const call = serverCall();
  const [stats, recent] = await Promise.all([orNull(botStats(call)), orNull(feed({ via: 'bot', limit: RECENT }, call))]);
  const example = await exampleThread(recent, call);
  return <BotView handle={botHandle()} stats={stats} recent={recent} example={example} />;
}
