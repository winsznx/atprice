'use client';

import { useEffect } from 'react';
import { useIsLgUp } from '@/lib/hooks/use-media-query';
import { getNotificationCenter } from '@/lib/notifications/store';
import { closeWalletPanel, useWalletOverlay } from '@/lib/wallet/ui-store';
import { useWalletState } from '@/lib/wallet/store';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { WalletStateView } from './wallet-state-view';

/**
 * The wallet panel (wallet.md): right Sheet (400px) at lg+, bottom Sheet below lg, opened by the
 * header wallet button in its connected, reconnecting, not answering and wrong-network states.
 * Radix returns focus to the wallet button on close.
 */
export function WalletPanel() {
  const { panelOpen } = useWalletOverlay();
  const state = useWalletState();
  const isLgUp = useIsLgUp();

  useEffect(() => {
    if (!panelOpen) return;
    return getNotificationCenter().openModal('wallet-panel');
  }, [panelOpen]);

  return (
    <Sheet open={panelOpen} onOpenChange={(open) => (open ? undefined : closeWalletPanel())}>
      <SheetContent side={isLgUp ? 'right' : 'bottom'}>
        <SheetHeader>
          <SheetTitle>Wallet</SheetTitle>
          <SheetDescription className="sr-only">
            Your connected wallet, owner address and balances.
          </SheetDescription>
        </SheetHeader>
        <WalletStateView state={state} mode="panel" headingLevel="h3" />
      </SheetContent>
    </Sheet>
  );
}
