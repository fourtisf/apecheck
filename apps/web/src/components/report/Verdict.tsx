'use client';
import { useEffect, useState } from 'react';
import { NOT_ENOUGH_LABEL, REPORT_DISCLAIMER, coinBand, fmtDur, narBand, notEnoughReason, otherChainCoinText, type CheckReportDTO } from '@apecheck/core';
import { cssVars } from '../css';
import { Age } from '../Now';
import { Ring } from '../Ring';
import { isRunning, noVerdict, notEnough, runSeconds } from './util';

/** ", requested by @x via @ApeCheckBot" and friends, as the prototype's v-meta line says it. */
function requestedBy(r: CheckReportDTO): string {
  if (r.mine) return ', requested by you';
  if (r.via === 'bot') return r.by ? `, requested by @${r.by} via @ApeCheckBot` : ', requested via @ApeCheckBot';
  if (r.via === 'api') return r.by ? `, requested by @${r.by} via the API` : ', requested via the API';
  return r.by ? `, requested by @${r.by} on the site` : ', requested on the site';
}

function stepsLine(r: CheckReportDTO): string {
  const n = r.steps.length;
  const secs = runSeconds(r);
  return `${n} step${n === 1 ? '' : 's'}${secs != null ? ` in ${fmtDur(secs)}` : ''}`;
}

/** mblock(): one score meter in the verdict panel. The bar grows from 0 when the verdict just landed. */
function ScoreMeter({ label, n, kind, hint, armed }: { label: string; n: number; kind: 'nar' | 'coin'; hint: string; armed: boolean }) {
  const b = kind === 'coin' ? coinBand(n) : narBand(n);
  return (
    <div className={`mb ${kind === 'coin' ? 'k' : 'n'}-${b.key}`}>
      <div className="mb-h">
        <span>{label}</span>
        <b>
          {n}
          <small>/100</small>
        </b>
      </div>
      <span className="mm-bar">
        <i style={{ width: `${armed ? n : 0}%`, transition: 'width .9s cubic-bezier(.2,.8,.2,1)' }} />
      </span>
      <span className="mb-t">
        <strong>{b.name}</strong> · {hint}
      </span>
    </div>
  );
}

function NoCoinMeter({ text }: { text: string }) {
  return (
    <div className="mb">
      <div className="mb-h">
        <span>Coin</span>
        <b style={{ color: 'var(--dim)' }}>—</b>
      </div>
      <span className="mb-t">{text}</span>
    </div>
  );
}

function Running({ r }: { r: CheckReportDTO }) {
  const pct = Math.round(Math.max(0, Math.min(1, r.progress)) * 100);
  const n = r.steps.length;
  const total = Math.max(r.stepsExpected, n);
  const last = r.steps[n - 1];
  const stepText = last ? `Step ${n} of ${total}: ${last.text}` : r.status === 'queued' ? 'Waiting for a free browser' : 'Starting a clean browser';
  return (
    <>
      <div className="rv-ring">
        <Ring value={pct} size={140} color="var(--acc)" id="rvArc" />
        <div className="rv-ring-in">
          <b id="rvPct" style={{ fontSize: 30 }}>
            {pct}%
          </b>
          <span>Testing</span>
        </div>
      </div>
      {/* stretch: on phones .rv start-aligns its items, and the one-line #rvStep would then widen the panel instead of ellipsizing */}
      <div className="rv-run" style={{ justifySelf: 'stretch' }}>
        <span className="vlabel" style={cssVars({ '--vc': 'var(--acc)' })}>
          Testing now
        </span>
        <p className="v-sum" style={{ marginTop: 14 }}>
          The agent is working through {total} steps. You can leave this page; the verdict lands in the feed when it&apos;s done.
        </p>
        <div className="rv-prog">
          <i id="rvProg" style={{ width: `${pct}%` }} />
        </div>
        <p className="v-meta" id="rvStep">
          {stepText}
        </p>
      </div>
    </>
  );
}

/** A check that could test nothing about the project: what was looked for, and no score (never the middle of unknowns). */
function NotEnough({ r }: { r: CheckReportDTO }) {
  return (
    <>
      <div className="rv-ring">
        <Ring value={0} size={140} color="transparent" id="rvTot" />
        <div className="rv-ring-in">
          <b style={{ color: 'var(--dim)' }}>—</b>
          <span>Total score</span>
        </div>
      </div>
      <div className="rv-l">
        <span className="vlabel" style={cssVars({ '--vc': 'var(--dim)' })}>
          {NOT_ENOUGH_LABEL}
        </span>
        <p className="v-sum">{notEnoughReason(r.error ?? '')}</p>
        <p className="v-note">There was nothing about the project to test, so there is no score. If it has a website or a contract, paste that to check it.</p>
        <p className="v-meta">
          Checked {r.finishedAt ? <Age ts={r.finishedAt} long /> : null}
          {requestedBy(r)} · {stepsLine(r)}
        </p>
      </div>
    </>
  );
}

/** A run that stopped before scoring: no verdict, and no invented one. */
function Failed({ r }: { r: CheckReportDTO }) {
  const last = r.steps[r.steps.length - 1];
  const why = last && last.status === 'fail' ? `${last.text.replace(/\.+$/, '')}. ` : '';
  return (
    <>
      <div className="rv-ring">
        <Ring value={0} size={140} color="transparent" id="rvTot" />
        <div className="rv-ring-in">
          <b style={{ color: 'var(--dim)' }}>—</b>
          <span>Total score</span>
        </div>
      </div>
      <div className="rv-l">
        <span className="vlabel" style={cssVars({ '--vc': 'var(--dim)' })}>
          No verdict
        </span>
        <p className="v-sum">The check stopped before a verdict.</p>
        <p className="v-note">{why}Re-check to try again.</p>
        <p className="v-meta">
          Stopped {r.finishedAt ? <Age ts={r.finishedAt} long /> : 'early'}
          {requestedBy(r)} · {stepsLine(r)}
        </p>
      </div>
    </>
  );
}

function Finished({ r, just }: { r: CheckReportDTO; just: boolean }) {
  // when the verdict lands while you watch, the ring and meters start empty and fill (prototype: two rAFs, then set)
  const [armed, setArmed] = useState(!just);
  useEffect(() => {
    if (armed) return;
    let f2 = 0;
    const f1 = requestAnimationFrame(() => {
      f2 = requestAnimationFrame(() => setArmed(true));
    });
    return () => {
      cancelAnimationFrame(f1);
      cancelAnimationFrame(f2);
    };
  }, [armed]);

  const nar = r.narScore ?? 0;
  const total = r.total ?? nar;
  const b = narBand(nar);
  const t = narBand(total);
  // a coin on a chain ApeCheck can't read was never checked: neither "couldn't be scored" nor "no coin linked"
  const coinText =
    !r.hasCoin && r.otherChain
      ? otherChainCoinText(r.otherChain.chain)
      : (r.hasCoin && r.coinScore == null) || r.kind === 'coin'
        ? "The coin couldn't be scored this time"
        : `No coin linked to this ${r.kind}`;
  return (
    <>
      <div className={`rv-ring n-${t.key}`}>
        <Ring value={armed ? total : 0} size={140} id="rvTot" />
        <div className="rv-ring-in">
          <b>{total}</b>
          <span>Total score</span>
        </div>
      </div>
      <div className="rv-l">
        <span className={`vlabel n-${b.key}${just ? ' slam' : ''}`}>{b.name}</span>
        {r.summary ? <p className="v-sum">{r.summary}</p> : null}
        <p className="v-note">{REPORT_DISCLAIMER}</p>
        <p className="v-meta">
          Checked {r.checkedAt ? <Age ts={r.checkedAt} long /> : null}
          {requestedBy(r)} · {stepsLine(r)}
        </p>
      </div>
      <div className="rv-s">
        <ScoreMeter label="Narrative" n={nar} kind="nar" hint="Is what they claim actually built?" armed={armed} />
        {r.hasCoin && r.coinScore != null ? (
          <ScoreMeter label="Coin" n={r.coinScore} kind="coin" hint="Is the token set up fairly?" armed={armed} />
        ) : (
          <NoCoinMeter text={coinText} />
        )}
      </div>
    </>
  );
}

/** rvHTML(it, just): the verdict panel (#rv). */
export function Verdict({ report: r, just }: { report: CheckReportDTO; just: boolean }) {
  let body;
  if (isRunning(r)) body = <Running r={r} />;
  else if (notEnough(r)) body = <NotEnough r={r} />;
  else if (noVerdict(r)) body = <Failed r={r} />;
  else body = <Finished r={r} just={just} />;
  return (
    <section className="rv panel" id="rv" aria-live="polite">
      {body}
    </section>
  );
}
