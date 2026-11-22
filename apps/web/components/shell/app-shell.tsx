'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppToaster } from '../app-toaster';
import { NotificationBridge } from '../notification-bridge';
import { ConnectModal } from '../wallet/connect-modal';
import { WalletPanel } from '../wallet/wallet-panel';
import { BlazeBanner } from './blaze-banner';
import { NetworkMismatchBanner } from './network-mismatch-banner';
import { SiteHeader } from './site-header';

/** The skip link is the first tab stop on every page and jumps past banner and header (DD 7.14, 8). */
function SkipLink() {
  return (
    <a
      href="#content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-skip) focus:rounded-md focus:bg-surface focus:px-4 focus:py-3 focus:text-label focus:text-fg focus:shadow-popover"
    >
      Skip to content
    </a>
  );
}

/**
 * The app shell (DD 8.1): skip link, the BLAZE banner on `/` only, header, network-mismatch banner,
 * `<main id="content">`, footer, the toast region with order polling, and the wallet overlays.
 */
export function AppShell({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      <SkipLink />
      {pathname === '/' ? <BlazeBanner /> : null}
      <SiteHeader />
      <NetworkMismatchBanner />
      <main id="content" tabIndex={-1} className="outline-none">
        {children}
      </main>
      {footer}
      <AppToaster />
      <NotificationBridge />
      <ConnectModal />
      <WalletPanel />
    </>
  );
}
