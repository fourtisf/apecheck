'use client';
import { useEffect, useState } from 'react';
import type { FeedResponse, InsightsDTO, LiveResponse } from '@apecheck/core';
import { insights as fetchInsights } from '@/lib/api';
import { useLive } from '../Live';
import { TokenCA } from '../TokenCA';
import { CreditLine } from './CreditLine';
import { HeroStats } from './HeroStats';
import { Insights } from './Insights';
import { LiveChecks } from './LiveChecks';
import { ProbeForm } from './ProbeForm';
import { Verdicts, type VerdictsCommand } from './Verdicts';

export interface FeedViewProps {
  /** server-rendered first page of GET /v1/feed (tab=latest, q=initialQ); null if the API didn't answer */
  initialFeed: FeedResponse | null;
  initialInsights: InsightsDTO | null;
  initialLive: LiveResponse | null;
  /** ?q= from the header search on another page */
  initialQ: string;
}

/** viewFeed(): hero with the check form, "Checking right now", the insight cards and the Verdicts list. */
export function FeedView({ initialFeed, initialInsights, initialLive, initialQ }: FeedViewProps) {
  const { onFinished } = useLive();
  const [insights, setInsights] = useState<InsightsDTO | null>(initialInsights);
  const [command, setCommand] = useState<VerdictsCommand | null>(null);

  useEffect(() => {
    const reload = () =>
      void fetchInsights()
        .then(setInsights)
        .catch(() => {});
    if (!initialInsights) reload();
    return onFinished(reload);
  }, [onFinished, initialInsights]);

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="hero-c">
            <TokenCA className="hero-ca" />
            <h1>
              Know what&apos;s real
              <br />
              before you ape.
            </h1>
            <p className="lede">
              Paste a coin, an X post or a link. An agent opens it in a real browser, tests every claim against the code, the chain and X, and gives
              you a verdict with the evidence.
            </p>
            <ProbeForm />
            <CreditLine />
            <HeroStats stats={insights?.stats} />
          </div>
          <LiveChecks initial={initialLive?.items ?? null} />
        </div>
      </section>
      <section className="wrap ins">
        <Insights data={insights} onMostCheckedAll={() => setCommand(c => ({ tab: 'checked', n: (c?.n ?? 0) + 1 }))} />
      </section>
      <section className="wrap feed">
        <div className="feed-h">
          <h2>Verdicts</h2>
        </div>
        <Verdicts initial={initialFeed} initialQ={initialQ} command={command} />
      </section>
    </>
  );
}
