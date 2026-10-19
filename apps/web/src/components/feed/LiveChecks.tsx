'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { KIND_LABEL, fmtT, type LiveCheckDTO } from '@apecheck/core';
import { reportPath } from '@/lib/env';
import { Avatar } from '../Avatar';
import { useLive } from '../Live';

function LiveCard({ it, elapsedMs }: { it: LiveCheckDTO; elapsedMs: number }) {
  const total = Math.max(it.stepsExpected, it.step, 1);
  const step = Math.min(Math.max(1, it.step), total);
  const pct = Math.max(0, Math.min(1, it.progress)) * 100;
  return (
    <Link className="lc" href={reportPath(it.id)} prefetch={false}>
      <span className="lc-top">
        <Avatar item={it} size={34} />
        <span className="lc-n">
          <b>
            {it.name}
            {it.mine ? <em>You</em> : null}
          </b>
          <small>
            {KIND_LABEL[it.kind]} · step {step} of {total}
          </small>
        </span>
        <time suppressHydrationWarning>{fmtT(elapsedMs / 1000)}</time>
      </span>
      <span className="lc-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
    </Link>
  );
}

/**
 * "Checking right now": running checks from GET /v1/live, polled every 3 s while the feed is open.
 * Elapsed times tick in the browser between polls.
 */
export function LiveChecks({ initial }: { initial: LiveCheckDTO[] | null }) {
  const live = useLive();
  const { subscribe } = live;
  const [now, setNow] = useState<number | null>(null);

  const seed = useRef(initial);
  useEffect(() => subscribe(seed.current), [subscribe]);

  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const fromPoll = live.items != null;
  const items = live.items ?? initial ?? [];
  // the server-rendered list has no receive time on this clock; it starts ticking from mount
  const [mountedAt] = useState(() => Date.now());
  const base = fromPoll ? live.receivedAt : mountedAt;
  const since = now == null ? 0 : Math.max(0, now - base);

  return (
    <div className="live-wrap">
      <div className="live-h">
        <span className="dotlive" />
        Checking right now <b id="liveN">{items.length}</b>
        <span className="live-hint">Open one to watch the agent work</span>
      </div>
      <div className="live-row" id="liveList">
        {items.length ? (
          items.map(it => <LiveCard key={it.id} it={it} elapsedMs={it.elapsedMs + since} />)
        ) : (
          <p className="live-empty">Nothing running right now. Paste something above to start a check.</p>
        )}
      </div>
    </div>
  );
}
