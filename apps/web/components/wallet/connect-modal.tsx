'use client';

import { useEffect, useRef } from 'react';
import { useIsMdUp } from '@/lib/hooks/use-media-query';
import { getNotificationCenter } from '@/lib/notifications/store';
import { closeConnectModal, resolveReturnFocus, useWalletOverlay } from '@/lib/wallet/ui-store';
import { getWalletConnector, useWalletState } from '@/lib/wallet/store';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { INTRO, WalletStateView } from './wallet-state-view';

/**
 * The connect modal (wallet.md): Dialog at md+, bottom Sheet below md, mounted once in the app shell
 * and opened by every `Connect wallet` trigger through `openConnectModal`. Closing while a code is
 * shown ends the pairing; focus returns per the entry-point table (DD 7.8).
 */
export function ConnectModal() {
  const { connectOpen, returnFocus } = useWalletOverlay();
  const state = useWalletState();
  const isMdUp = useIsMdUp();
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!connectOpen) return;
    return getNotificationCenter().openModal('connect');
  }, [connectOpen]);

  const onOpenChange = (open: boolean) => {
    if (open) return;
    closeConnectModal();
    getWalletConnector()
      .cancelPairing()
      .catch((error: unknown) => console.error('Ending the pairing failed:', error));
  };

  const onOpenAutoFocus = (event: Event) => {
    event.preventDefault();
    titleRef.current?.focus();
  };

  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    resolveReturnFocus(returnFocus)?.focus();
  };

  const body = (
    <WalletStateView state={state} mode="modal" headingLevel="h3" onDone={() => onOpenChange(false)} />
  );

  if (isMdUp) {
    return (
      <Dialog open={connectOpen} onOpenChange={onOpenChange}>
        <DialogContent onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle ref={titleRef} tabIndex={-1}>
              Connect a wallet
            </DialogTitle>
            <DialogDescription>{INTRO}</DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={connectOpen} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
        <SheetHeader>
          <SheetTitle ref={titleRef} tabIndex={-1}>
            Connect a wallet
          </SheetTitle>
          <SheetDescription>{INTRO}</SheetDescription>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}
