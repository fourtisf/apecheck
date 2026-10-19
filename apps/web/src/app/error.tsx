'use client';
import Link from 'next/link';

/** Last-resort boundary for a page that crashed while rendering. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="wrap page">
      <div className="empty">
        <p>Something went wrong on our side. Try again in a moment.</p>
        <button className="btn" type="button" onClick={reset}>
          Try again
        </button>{' '}
        <Link className="btn" href="/">
          Back to the feed
        </Link>
      </div>
    </div>
  );
}
