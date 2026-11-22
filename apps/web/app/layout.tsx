import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { publicEnv } from '@/lib/env/public';
import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  SITE_KEYWORDS,
  SITE_LOCALE,
  SITE_NAME,
  SITE_URL,
  siteRobots,
} from '@/lib/seo';
import { cn } from '@/lib/utils';
import { bricolage, inter, jetbrainsMono } from './fonts';
import './globals.css';

/**
 * Site-wide tags, written as the home page's own share card: `/` inherits all of it (and the root
 * opengraph-image), while every other route sets its own through `pageMetadata`.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: HOME_TITLE, template: `%s · ${SITE_NAME}` },
  description: HOME_DESCRIPTION,
  keywords: [...SITE_KEYWORDS],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  applicationName: SITE_NAME,
  category: 'finance',
  referrer: 'no-referrer',
  formatDetection: { telephone: false, address: false, email: false },
  alternates: { canonical: '/' },
  robots: siteRobots(publicEnv.network),
  openGraph: {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    url: '/',
    siteName: SITE_NAME,
    locale: SITE_LOCALE,
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: HOME_TITLE, description: HOME_DESCRIPTION },
  appleWebApp: { title: SITE_NAME, statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: 'white',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // Every page renders per request: Next stamps proxy.ts's per-request CSP nonce on its scripts only then.
  await connection();
  return (
    <html lang="en" className={cn(bricolage.variable, inter.variable, jetbrainsMono.variable)}>
      <body className="min-h-dvh bg-surface font-sans text-body text-fg antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
