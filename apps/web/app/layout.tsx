import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { cn } from '@/lib/utils';
import { bricolage, inter, jetbrainsMono } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'AtPrice', template: '%s · AtPrice' },
  description: 'Limit orders for Bitcoin Cash tokens, filled through Cauldron pools.',
  applicationName: 'AtPrice',
  referrer: 'no-referrer',
  formatDetection: { telephone: false, address: false, email: false },
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
