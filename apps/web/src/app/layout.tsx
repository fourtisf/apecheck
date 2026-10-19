import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppProvider } from '@/components/AppProvider';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { me } from '@/lib/api';
import { APP_URL } from '@/lib/env';
import { orNull, serverCall } from '@/lib/server-api';
import { THEME_COLOR, THEME_SCRIPT } from '@/lib/theme';
import './globals.css';

const DESCRIPTION =
  'Paste a coin, an X post or a link. An agent tests every claim against the code, the chain and X, and stamps a verdict with the evidence.';

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  // pages set `title: 'Coins'` and get "Coins · ApeCheck"
  title: { default: 'ApeCheck — real build or LARP?', template: '%s · ApeCheck' },
  description: DESCRIPTION,
  openGraph: { siteName: 'ApeCheck', title: 'ApeCheck — real build or LARP?', description: DESCRIPTION, type: 'website' },
  twitter: { card: 'summary_large_image', site: '@ApeCheckBot' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/** The header's viewer (tier, address, credits) on first paint; the browser asks again after hydration. */
const ME_TIMEOUT_MS = 2500;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const initialMe = await orNull(me(serverCall({ timeoutMs: ME_TIMEOUT_MS })));
  return (
    // the head script switches data-theme before paint, so the server's "light" may not match on hydration
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content={THEME_COLOR.light} suppressHydrationWarning />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400..800&family=Geist+Mono:wght@400..600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AppProvider initialMe={initialMe}>
          <Header />
          <main id="app">{children}</main>
          <Footer />
        </AppProvider>
      </body>
    </html>
  );
}
