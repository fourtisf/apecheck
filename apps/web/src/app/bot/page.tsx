import type { Metadata } from 'next';
import { botStats, feed, report } from '@/lib/api';
import { orNull, serverCall } from '@/lib/server-api';
import { BotView } from '@/components/pages/BotView';
import { pickBotExample } from '@/components/pages/botExample';

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

export default async function BotPage() {
  const call = serverCall();
  const [stats, recent] = await Promise.all([orNull(botStats(call)), orNull(feed({ via: 'bot', limit: RECENT }, call))]);
  // a real thread only from a reply the bot posted; otherwise a labelled illustration, or none (see botExample.ts)
  const example = await pickBotExample(recent, {
    postChecks: limit => orNull(feed({ type: 'post', limit }, call)),
    report: id => orNull(report(id, call)),
  });
  return <BotView handle={botHandle()} stats={stats} recent={recent} example={example} />;
}
