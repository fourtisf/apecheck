'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { KIND_LABEL, detect, short, type CheckReportDTO } from '@apecheck/core';
import { NETWORK_ERROR } from '@/lib/api';
import { useActions } from '../Actions';
import { Avatar } from '../Avatar';
import { useMe } from '../Me';
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

/**
 * The Watch toast, by what watching gets this viewer (HANDOFF §8): Max watchlists are re-checked on their own, Pro gets
 * an alert when the site or contract changes, Free and a browser list get neither.
 */
export function watchToast(on: boolean, signedIn: boolean, tier: 'free' | 'pro' | 'max'): string {
  if (!on) return 'Removed from your watchlist';
  if (!signedIn) return 'Watching in this browser. Connect a wallet to keep it on your account; re-check alerts come with Pro.';
  if (tier === 'free') return 'Added to your watchlist. Re-check alerts come with Pro.';
  if (tier === 'pro') return "Watching. You'll get an alert when the site or contract changes.";
  return "Watching. You'll get a re-check when the site or contract changes.";
}

/** Crumb, title, meta line and the Watch / Re-check / Share card actions. */
export function ReportHeader({ report: r }: { report: CheckReportDTO }) {
  const { startCheck, openShare } = useActions();
  const toast = useToast();
  const watch = useWatchlist();
  const { me } = useMe();
  const [rechecking, setRechecking] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  // the answer of this page's last toggle, until the watchlist store has caught up
  const [toggled, setToggled] = useState<boolean | null>(null);
  useEffect(() => setToggled(null), [watch.version, watch.mode]);
  const running = isRunning(r);
  const item = { id: r.id, targetId: r.targetId };
  // signed in: the account's list once loaded, else the server render's `watching`; signed out: this browser's list
  const known = watch.mode === 'account' ? (watch.list ? watch.isWatching(item) : null) : watch.ready ? watch.isWatching(item) : null;
  const watching = toggled ?? known ?? !!r.watching;
  const site = siteLink(r);
  const handle = r.handle;

  const copy = () => {
    if (!r.ca) return;
    navigator.clipboard?.writeText(r.ca).catch(() => {});
    toast('Contract address copied');
  };

  const toggleWatch = async () => {
    if (watchBusy) return;
    setWatchBusy(true);
    try {
      const on = await watch.setWatching(item, !watching);
      setToggled(on);
      toast(watchToast(on, watch.mode === 'account', me?.tier ?? 'free'));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : NETWORK_ERROR);
    } finally {
      setWatchBusy(false);
    }
  };

  const recheck = async () => {
    const target = recheckTarget(r);
    if (!target || rechecking) return;
    setRechecking(true);
    try {
      // a private report is re-checked privately (Max)
      await startCheck(target, { recheck: true, private: r.isPrivate || undefined });
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
            {r.isPrivate ? (
              <span className="lock" title="Only you can see this check">
                Private
              </span>
            ) : null}
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
          <button className="btn" type="button" aria-pressed={watching} aria-busy={watchBusy || undefined} onClick={() => void toggleWatch()}>
            {watching ? 'Watching' : 'Watch'}
          </button>
          <button className="btn" type="button" disabled={running || rechecking || !recheckTarget(r)} onClick={() => void recheck()}>
            Re-check <small>1 credit</small>
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={running || r.narScore == null}
            // a private report's link opens only for its owner: the card can be downloaded, not posted
            onClick={() => openShare(r, r.isPrivate ? { postable: false } : { onPost: () => shareOnX(r) })}
          >
            Share card
          </button>
        </div>
      </header>
    </>
  );
}
