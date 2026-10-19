import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { narBand, type CheckReportDTO } from '@apecheck/core';
import { ReportView } from '@/components/report/ReportView';
import { isApiError, report } from '@/lib/api';
import { reportPath } from '@/lib/env';
import { serverCall } from '@/lib/server-api';

// a running check changes every second, a finished one when notes, asks or prices change
export const dynamic = 'force-dynamic';

type Loaded = { ok: true; report: CheckReportDTO } | { ok: false; missing: boolean; message: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One API call per request, shared by generateMetadata and the page. */
const load = cache(async (id: string): Promise<Loaded> => {
  if (!ID_RE.test(id)) return { ok: false, missing: true, message: '' };
  try {
    return { ok: true, report: await report(id, serverCall()) };
  } catch (e) {
    if (isApiError(e, 'not_found')) return { ok: false, missing: true, message: '' };
    return { ok: false, missing: false, message: e instanceof Error && e.message ? e.message : "Couldn't reach ApeCheck. Try again in a moment." };
  }
});

/** "<name> — <Verdict> <total>/100" (the layout adds " · ApeCheck"). */
function titleOf(r: CheckReportDTO): string {
  if (r.status === 'queued' || r.status === 'running') return `${r.name} — Testing now`;
  if (r.narScore == null) return `${r.name} — No verdict`;
  return `${r.name} — ${narBand(r.narScore).name} ${r.total ?? r.narScore}/100`;
}

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const res = await load(params.id);
  if (!res.ok) return { title: res.missing ? 'Not found' : 'Report', robots: { index: false } };
  const r = res.report;
  const title = titleOf(r);
  const description = r.summary ?? `What ApeCheck's agent found when it tested ${r.name}.`;
  const path = reportPath(r.id);
  const done = r.status === 'done' && r.narScore != null;
  const image = `/card/${encodeURIComponent(r.id)}.png`;
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: r.isPrivate ? { index: false } : undefined,
    openGraph: {
      siteName: 'ApeCheck',
      type: 'article',
      url: path,
      title: `${title} · ApeCheck`,
      description,
      images: done ? [{ url: image, width: 1200, height: 675, alt: `${r.name}: ${title.split(' — ')[1]}` }] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      site: '@ApeCheckBot',
      title: `${title} · ApeCheck`,
      description,
      images: done ? [image] : undefined,
    },
  };
}

export default async function ReportPage({ params }: { params: { id: string } }) {
  const res = await load(params.id);
  if (!res.ok) {
    if (res.missing) notFound();
    return (
      <div className="wrap page">
        <div className="empty">
          <p>Couldn&apos;t load this check right now. {res.message}</p>
          <a className="btn" href={reportPath(params.id)}>
            Try again
          </a>{' '}
          <Link className="btn" href="/">
            Back to the feed
          </Link>
        </div>
      </div>
    );
  }
  // a re-check navigates to another id: start that report fresh
  return <ReportView key={res.report.id} initial={res.report} />;
}
