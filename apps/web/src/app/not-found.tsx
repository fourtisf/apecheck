import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <div className="wrap page">
      <div className="empty">
        <p>This page doesn&apos;t exist.</p>
        <Link className="btn" href="/">
          Back to the feed
        </Link>
      </div>
    </div>
  );
}
