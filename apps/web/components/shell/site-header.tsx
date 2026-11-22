'use client';

import { ListIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getNotificationCenter } from '@/lib/notifications/store';
import { cn } from '@/lib/utils';
import { Lockup } from '../mark';
import { NetworkBadge } from '../status-badge';
import { Button, CONTROL_TRANSITION } from '../ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet';
import { WalletButton } from '../wallet/wallet-button';
import { NAV_ITEMS, isActive } from './site-nav';

function MobileMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    // A navigation from inside the menu closes it.
    setLastPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    return getNotificationCenter().openModal('menu');
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="icon"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="lg:hidden"
      >
        <ListIcon aria-hidden="true" />
      </Button>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>
        <nav aria-label="Main">
          <ul className="flex flex-col">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                  className={cn(
                    'flex min-h-(--size-control) items-center rounded-sm px-2 text-body text-fg-secondary hover:bg-surface-sunken aria-[current=page]:font-semibold aria-[current=page]:text-fg',
                    CONTROL_TRANSITION,
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/recover"
                className={cn(
                  'flex min-h-(--size-control) items-center rounded-sm px-2 text-body text-fg-secondary hover:bg-surface-sunken',
                  CONTROL_TRANSITION,
                )}
              >
                Recover an order
              </Link>
            </li>
          </ul>
        </nav>
        <NetworkBadge className="self-start" />
      </SheetContent>
    </Sheet>
  );
}

/**
 * DD 8 header: 64px, sticky through `[data-site-header]` (static under the short rule), lockup, inline
 * nav at lg+, network badge and the wallet button; below lg a `Menu` sheet carries the nav.
 */
export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header data-site-header className="z-(--z-header) border-b border-border bg-surface">
      <div className="mx-auto flex h-(--size-header) max-w-(--container-app) items-center gap-2 px-(--space-gutter) md:px-(--space-gutter-md) lg:gap-6 lg:px-(--space-gutter-lg)">
        <Lockup />
        <nav aria-label="Main" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV_ITEMS.filter((item) => item.desktop).map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                  className={cn(
                    'relative inline-flex min-h-(--size-control) items-center px-3 text-label text-fg-secondary hover:text-fg',
                    'aria-[current=page]:text-fg aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-3 aria-[current=page]:after:bottom-1 aria-[current=page]:after:h-0.5 aria-[current=page]:after:bg-brand',
                    CONTROL_TRANSITION,
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2 lg:gap-3">
          <NetworkBadge className="hidden lg:inline-flex" />
          <WalletButton />
          <MobileMenu pathname={pathname} />
        </div>
      </div>
    </header>
  );
}
