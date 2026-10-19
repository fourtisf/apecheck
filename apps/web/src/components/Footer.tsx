import Link from 'next/link';
import { FOOTER_DISCLAIMER } from '@apecheck/core';

export function Footer() {
  return (
    <footer>
      <div className="wrap foot">
        <span>{FOOTER_DISCLAIMER}</span>
        <nav aria-label="Footer">
          <Link href="/">Feed</Link>
          <Link href="/bot">@ApeCheckBot</Link>
          <Link href="/api">API</Link>
          <Link href="/coins">Coins</Link>
          <Link href="/deployers">Deployers</Link>
        </nav>
      </div>
    </footer>
  );
}
