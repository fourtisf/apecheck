import Link from 'next/link';
import { FOOTER_DISCLAIMER } from '@apecheck/core';
import { X_URL } from '@/lib/env';
import { TokenCA } from './TokenCA';

export function Footer() {
  return (
    <footer>
      <div className="wrap foot">
        <div className="foot-l">
          <TokenCA />
          <span>{FOOTER_DISCLAIMER}</span>
        </div>
        <nav aria-label="Footer">
          <Link href="/">Feed</Link>
          <Link href="/bot">@ApeCheckBot</Link>
          <Link href="/api">API</Link>
          <Link href="/coins">Coins</Link>
          <Link href="/deployers">Deployers</Link>
          <a href={X_URL} target="_blank" rel="noopener noreferrer">
            X
          </a>
        </nav>
      </div>
    </footer>
  );
}
