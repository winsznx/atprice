'use client';

import { useWalletState } from '@/lib/wallet/store';
import { WalletStateView } from './wallet-state-view';

/**
 * `/wallet` (wallet.md "Routes"): the panel content as a page. Disconnected, the connect content renders
 * inline instead of in a modal; every state change moves focus to the new state's heading.
 */
export function WalletPageContent() {
  const state = useWalletState();
  return (
    <section aria-label="Wallet connection" className="rounded-lg border border-border p-5 lg:p-6">
      {state.kind === 'loading' ? (
        <p role="status" className="sr-only">
          Loading the wallet connection
        </p>
      ) : null}
      <WalletStateView state={state} mode="page" />
    </section>
  );
}
