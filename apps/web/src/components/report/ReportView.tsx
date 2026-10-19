'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { CheckReportDTO, StepDTO } from '@apecheck/core';
import { report as fetchReport } from '@/lib/api';
import { AsksTab } from './AsksTab';
import { ClaimsTab } from './ClaimsTab';
import { CoinTab } from './CoinTab';
import { NotesTab } from './NotesTab';
import { PeopleTab } from './PeopleTab';
import { ReportHeader } from './ReportHeader';
import { RunTab } from './RunTab';
import { Side } from './Side';
import { useCheckEvents } from './useCheckEvents';
import { Verdict } from './Verdict';
import { isRunning, runSeconds, withStep } from './util';

type TabKey = 'run' | 'claims' | 'coin' | 'people' | 'asks' | 'notes';
const TABS: [TabKey, string][] = [
  ['run', 'Agent run'],
  ['claims', 'Claims'],
  ['coin', 'Coin'],
  ['people', 'People'],
  ['asks', 'Asks'],
  ['notes', 'Notes'],
];

const parseTime = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * viewReport(): the whole report for one check. A queued/running check streams its log over SSE and
 * swaps to the finished report in place when `done` arrives (the verdict "lands" with the prototype's
 * animations and the Agent run tab stays open on "Finished").
 */
export function ReportView({ initial }: { initial: CheckReportDTO }) {
  const [r, setR] = useState(initial);
  const [just, setJust] = useState(false);
  const [gone, setGone] = useState(false);
  const running = isRunning(r);
  const [tab, setTab] = useState<TabKey>(running ? 'run' : 'claims');
  // local clock estimate of the run's start, for the ticking timer
  const [startAt, setStartAt] = useState<number | null>(() => parseTime(initial.startedAt));

  useCheckEvents(r.id, running && !gone, {
    step(s) {
      const { progress, ...step } = s;
      setR(prev => {
        const steps = withStep(prev.steps, step as StepDTO);
        return {
          ...prev,
          status: prev.status === 'queued' ? 'running' : prev.status,
          steps,
          stepsExpected: Math.max(prev.stepsExpected, steps.length),
          progress: Math.max(prev.progress, progress ?? 0),
        };
      });
      setStartAt(t => t ?? Date.now() - (step.t ?? 0));
    },
    status(s) {
      // terminal statuses wait for the `done` event, which carries the finished report
      if (s.status !== 'queued' && s.status !== 'running') return;
      setR(prev => ({ ...prev, status: s.status, progress: Math.max(prev.progress, s.progress ?? 0) }));
      if (s.status === 'running') setStartAt(t => t ?? Date.now());
    },
    done(final) {
      setR(final);
      setJust(final.status === 'done');
      setTab('run');
    },
    gone() {
      setGone(true);
    },
  });

  // The server render can't see the visitor's API cookie: ask once from the browser so "requested by you" is right.
  useEffect(() => {
    if (initial.via !== 'web' || isRunning(initial)) return;
    const ctrl = new AbortController();
    fetchReport(initial.id, { signal: ctrl.signal })
      .then(fresh => setR(prev => (prev.id === fresh.id && prev.status === fresh.status ? fresh : prev)))
      .catch(() => {});
    return () => ctrl.abort();
  }, [initial]);

  if (gone) {
    return (
      <div className="wrap page">
        <div className="empty">
          <p>This check doesn&apos;t exist or has expired.</p>
          <Link className="btn" href="/">
            Back to the feed
          </Link>
        </div>
      </div>
    );
  }

  const shown: TabKey = running ? 'run' : tab;
  let panel;
  switch (shown) {
    case 'run':
      panel = (
        <RunTab steps={r.steps} live={running} queued={r.status === 'queued'} startAt={startAt} totalSec={running ? null : runSeconds(r)} />
      );
      break;
    case 'claims':
      panel = <ClaimsTab report={r} />;
      break;
    case 'coin':
      panel = <CoinTab report={r} />;
      break;
    case 'people':
      panel = <PeopleTab report={r} />;
      break;
    case 'asks':
      panel = (
        <AsksTab
          checkId={r.id}
          list={r.asksList}
          count={r.asks}
          onAsked={a => setR(prev => ({ ...prev, asksList: [a, ...prev.asksList], asks: prev.asks + 1 }))}
        />
      );
      break;
    case 'notes':
      panel = <NotesTab checkId={r.id} list={r.notes} onChange={notes => setR(prev => ({ ...prev, notes }))} />;
      break;
  }

  return (
    // scanned text (URLs in steps, claims, evidence) can hold long unbroken words: wrap them instead of widening the page
    <div className="wrap rep" style={{ overflowWrap: 'break-word' }}>
      <ReportHeader report={r} />
      <Verdict report={r} just={just} />
      <div className="rep-g">
        <div className="rep-main">
          <div className="rtabs" role="tablist" aria-label="Report">
            {TABS.map(([k, label]) => {
              const off = running && k !== 'run';
              return (
                <button
                  key={k}
                  id={`rt-${k}`}
                  type="button"
                  role="tab"
                  aria-selected={shown === k}
                  aria-controls="tp"
                  disabled={off}
                  title={off ? 'Available when the check finishes' : undefined}
                  onClick={() => setTab(k)}
                >
                  {label}
                  {k === 'asks' ? <small>{r.asks}</small> : k === 'notes' ? <small>{r.notes.length}</small> : null}
                </button>
              );
            })}
          </div>
          <div id="tp" role="tabpanel" aria-labelledby={`rt-${shown}`}>
            {panel}
          </div>
        </div>
        <Side report={r} />
      </div>
    </div>
  );
}
