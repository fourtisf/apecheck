'use client';
import Link from 'next/link';
import { useState } from 'react';
import { KIND_LABEL, detect, short, type CheckReportDTO } from '@apecheck/core';
import { useActions } from '../Actions';
import { Avatar } from '../Avatar';
import { ChainTag } from '../ChainTag';
import { CopyIcon } from '../icons';
import { postToX, shareText } from '../ShareModal';
import { useToast } from '../Toast';
import { useWatchlist } from '../Watchlist';
import { isRunning, safeHttpUrl } from './util';

const EXT = { target: '_blank', rel: 'noopener noreferrer nofollow' } as const;

/** What to paste for a re-check: what the user pasted originally, else the project's CA / domain. */
function recheckTarget(r: CheckReportDTO): string | null {
  const ok = (v: string | null | undefined) => {
    const d = v ? detect(v) : null;
    return d && d.kind !== 'bad' ? v! : null;
  };
  return ok(r.targetRaw) ?? ok(r.ca) ?? ok(r.domain);
}

function siteLink(r: CheckReportDTO): { href: string; text: string } | null {
  const href = safeHttpUrl(r.links.site) ?? (r.domain ? `https://${r.domain}` : null);
  if (!href) return null;
  let text = r.domain;
  if (!text) {
    try {
      text = new URL(href).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }
  return { href, text };
}

/** Post the verdict to X with the report link the API gave us. */
function shareOnX(r: CheckReportDTO) {
  const url = safeHttpUrl(r.reportUrl);
  if (!url) return postToX(r);
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(shareText(r))}&url=${encodeURIComponent(url)}`;
  window.open(intent, '_blank', 'noopener,noreferrer');
}

/** Crumb, title, meta line and the Watch / Re-check / Share card actions. */
export function ReportHeader({ report: r }: { report: CheckReportDTO }) {
  const { startCheck, openShare } = useActions();
  const toast = useToast();
  const watch = useWatchlist();
  const [rechecking, setRechecking] = useState(false);
  const running = isRunning(r);
  const watching = watch.ready && watch.has(r.id);
  const site = siteLink(r);
  const handle = r.handle;

  const copy = () => {
    if (!r.ca) return;
    navigator.clipboard?.writeText(r.ca).catch(() => {});
    toast('Contract address copied');
  };

  const toggleWatch = () => {
    const on = watch.toggle(r.id);
    toast(on ? "Watching. You'll get a re-check when the site or contract changes." : 'Removed from your watchlist');
  };

  const recheck = async () => {
    const target = recheckTarget(r);
    if (!target || rechecking) return;
    setRechecking(true);
    try {
      await startCheck(target, { recheck: true });
    } finally {
      setRechecking(false);
    }
  };

  return (
    <>
      <nav className="crumb" aria-label="Breadcrumb">
        <Link href="/">Feed</Link>
        <span>/</span>
        <span>{r.name}</span>
      </nav>
      <header className="rep-head">
        <Avatar item={r} size={56} />
        <div className="rh-id">
          <h1>{r.name}</h1>
          <div className="rh-meta">
            <span className="tag">{KIND_LABEL[r.kind]}</span>
            <ChainTag chain={r.chain} />
            {r.ca ? (
              <button className="ca" type="button" onClick={copy} aria-label="Copy contract address" title={r.ca}>
                {short(r.ca)}
                <CopyIcon />
              </button>
            ) : null}
            {site ? (
              <a className="lnk" href={site.href} {...EXT}>
                {site.text}
              </a>
            ) : null}
            {handle ? (
              <a className="lnk" href={`https://x.com/${encodeURIComponent(handle)}`} {...EXT}>
                @{handle}
              </a>
            ) : null}
          </div>
        </div>
        <div className="rh-act">
          <button className="btn" type="button" aria-pressed={watching} onClick={toggleWatch}>
            {watching ? 'Watching' : 'Watch'}
          </button>
          <button className="btn" type="button" disabled={running || rechecking || !recheckTarget(r)} onClick={() => void recheck()}>
            Re-check <small>1 credit</small>
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={running || r.narScore == null}
            onClick={() => openShare(r, { onPost: () => shareOnX(r) })}
          >
            Share card
          </button>
        </div>
      </header>
    </>
  );
}
