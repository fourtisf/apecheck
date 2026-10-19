'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const NAV: { href: string; label: string }[] = [
  { href: '/', label: 'Feed' },
  { href: '/coins', label: 'Coins' },
  { href: '/deployers', label: 'Deployers' },
  { href: '/bot', label: 'X bot' },
  { href: '/api', label: 'API' },
];

/** route(): the current page's pill is dark; report pages (/c/...) count as the Feed. */
export function isCurrent(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/c/');
  return pathname === href || pathname.startsWith(href + '/');
}

/** The nav pills; rendered twice by the header (.nav on desktop, .nav-m under it on small screens). */
export function NavLinks({ className, id }: { className: 'nav' | 'nav-m'; id?: string }) {
  const pathname = usePathname() || '/';
  return (
    <nav className={className} aria-label="Main" id={id}>
      {NAV.map(n => (
        <Link key={n.href} href={n.href} aria-current={isCurrent(n.href, pathname) ? 'page' : undefined}>
          {n.label}
        </Link>
      ))}
    </nav>
  );
}
