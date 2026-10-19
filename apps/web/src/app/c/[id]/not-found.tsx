import Link from 'next/link';

/** The prototype's route() fallback for an unknown report id. */
export default function CheckNotFound() {
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
