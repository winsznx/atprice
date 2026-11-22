'use client';

import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { formatElapsed } from '@/lib/format';
import { useElapsed } from '@/lib/hooks/use-now';
import type { FundingFlow } from './flow';

/**
 * trade.md "Funding in progress": while the wallet is asked to sign, the ticket shows the same wait
 * with its elapsed time and `Cancel request`. The elapsed time is not announced each second.
 */
export function FundingStatusCard({ flow }: { flow: FundingFlow }) {
  const phase = useSyncExternalStore(flow.subscribe, flow.getPhase, flow.getPhase);
  const elapsed = useElapsed(phase.kind === 'awaiting_signature' ? phase.since : null);
  if (phase.kind !== 'awaiting_signature') return null;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-status-pending-subtle p-4">
      <p className="text-label font-semibold text-fg">
        Waiting for your wallet ·{' '}
        <span className="num" aria-hidden="true">
          {elapsed === null ? '0:00' : formatElapsed(elapsed)}
        </span>
      </p>
      <p className="text-body-sm text-fg-secondary">
        Approve the transaction in your wallet. Nothing is sent until you approve.
      </p>
      <Button variant="outline" size="compact" className="self-start" onClick={() => flow.cancelRequest()}>
        Cancel request
      </Button>
    </div>
  );
}
