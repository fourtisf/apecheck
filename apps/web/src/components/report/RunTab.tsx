'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { fmtT, type StepDTO } from '@apecheck/core';
import { shotUrl } from '@/lib/api';
import { Camera } from './Camera';

/** "Replay run" shows one step about every 800 ms, like the prototype's replay. */
const REPLAY_STEP_MS = 800;
/** the caption switches to "Done" a moment after the last replayed step */
const REPLAY_DONE_DELAY_MS = 900;
const TICK_MS = 250;

export interface RunTabProps {
  steps: StepDTO[];
  /** queued or running: steps stream in */
  live: boolean;
  queued: boolean;
  /** local clock estimate of when the run started (null while queued) */
  startAt: number | null;
  /** total run time in seconds once finished */
  totalSec: number | null;
}

function findLast<T>(a: T[], f: (x: T) => unknown): T | undefined {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return a[i];
  return undefined;
}

/** tabRun(): run state + time, the camera with the agent's screenshots, and the step log. */
export function RunTab({ steps, live, queued, startAt, totalSec }: RunTabProps) {
  const [replayStart, setReplayStart] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const logRef = useRef<HTMLOListElement>(null);

  const n = steps.length;
  const replaying = !live && replayStart != null;
  const replayElapsed = replaying ? Math.max(0, now - replayStart) : 0;
  const replayEnd = n * REPLAY_STEP_MS;
  const replayDone = replaying && replayElapsed >= replayEnd;

  const ticking = (live && !queued) || (replaying && replayElapsed < replayEnd + REPLAY_DONE_DELAY_MS);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(t);
  }, [ticking]);

  // the finished run goes back to "Finished" when the check is replaced (e.g. the verdict landed)
  useEffect(() => {
    if (live) setReplayStart(null);
  }, [live]);

  const shown = replaying ? steps.slice(0, Math.min(n, Math.floor(replayElapsed / REPLAY_STEP_MS) + 1)) : steps;

  // while the run streams, the newest screenshot takes over again
  useEffect(() => {
    if (live) setPinned(null);
  }, [live, n]);

  useEffect(() => {
    const ol = logRef.current;
    if (ol) ol.scrollTop = ol.scrollHeight;
  }, [shown.length]);

  const pinnedStep = pinned != null ? shown.find(s => s.idx === pinned && s.screenshot) : undefined;
  const shotStep = pinnedStep ?? findLast(shown, s => s.screenshot);
  const url = findLast(shown, s => s.url)?.url ?? null;

  let caption: string;
  if (pinnedStep) caption = pinnedStep.caption || pinnedStep.text;
  else if (live || (replaying && replayElapsed < replayEnd + REPLAY_DONE_DELAY_MS)) caption = findLast(shown, s => s.caption)?.caption ?? 'Waiting';
  else caption = 'Done';

  const idle = live || replaying || n === 0 ? 'Starting a clean browser…' : 'No screenshots from this run';

  let state;
  if (live) {
    state = (
      <>
        <i className="pulse" />
        Testing
      </>
    );
  } else if (replaying && !replayDone) {
    state = (
      <>
        <i className="pulse" />
        Replaying
      </>
    );
  } else state = replayDone ? 'Replay finished' : 'Finished';

  let seconds: number;
  const lastT = (steps[n - 1]?.t ?? 0) / 1000;
  if (live) seconds = startAt != null ? Math.max(lastT, (now - startAt) / 1000) : queued ? 0 : lastT;
  else if (replaying) seconds = Math.min(1, replayEnd ? replayElapsed / replayEnd : 1) * (totalSec ?? lastT);
  // rounded like fmtDur in the verdict's "n steps in 2m 13s", so both say the same time
  else seconds = Math.round(totalSec ?? lastT);

  const replay = () => {
    setPinned(null);
    setNow(Date.now());
    setReplayStart(Date.now());
  };

  const toggle = (s: StepDTO) => {
    if (!s.screenshot) return;
    setPinned(p => (p === s.idx ? null : s.idx));
  };
  const onKey = (e: KeyboardEvent, s: StepDTO) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(s);
    }
  };

  return (
    <>
      <div className="run-top">
        <span className="status" id="runState">
          {state}
        </span>
        {/* a live timer: the server's render and the browser's can be a second apart */}
        <time id="runTime" suppressHydrationWarning>
          {fmtT(seconds)}
        </time>
        <span className="sp" />
        {!live && n > 0 ? (
          <button className="btn sm" type="button" onClick={replay}>
            Replay run
          </button>
        ) : null}
      </div>
      <div className="run-g">
        <Camera
          url={url}
          shot={shotUrl(shotStep?.screenshot)}
          caption={caption}
          idle={idle}
          alt={shotStep ? `Screenshot: ${shotStep.text}` : ''}
        />
        <div className="log">
          <div className="log-h">What the agent {live ? 'is doing' : 'did'}</div>
          <ol id="logList" ref={logRef}>
            {shown.map(s => {
              const clickable = !!s.screenshot;
              return (
                <li
                  key={s.idx}
                  className={s.status}
                  onClick={clickable ? () => toggle(s) : undefined}
                  onKeyDown={clickable ? e => onKey(e, s) : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  title={clickable ? "Show this step's screenshot" : undefined}
                  aria-current={pinnedStep?.idx === s.idx ? 'step' : undefined}
                  style={
                    clickable
                      ? { cursor: 'pointer', boxShadow: pinnedStep?.idx === s.idx ? 'inset 2px 0 0 var(--acc)' : undefined }
                      : undefined
                  }
                >
                  <time>{fmtT(s.t / 1000)}</time>
                  <span className="ic" />
                  <span>
                    {s.text}
                    {s.source ? <em>{s.source}</em> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </>
  );
}
