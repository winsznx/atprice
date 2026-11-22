'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { getQueryClient } from '@/lib/api/query-client';
import { getWalletConnector } from '@/lib/wallet/store';
import { TooltipProvider } from './ui/tooltip';

/** Starts the tab's WizardConnect connector once: library load, compatibility check, session resume. */
function WalletBoot() {
  useEffect(() => {
    getWalletConnector()
      .start()
      .catch((error: unknown) => console.error('Wallet connector failed to start:', error));
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={700}>
        <WalletBoot />
        {children}
      </TooltipProvider>
    </QueryClientProvider>
  );
}
