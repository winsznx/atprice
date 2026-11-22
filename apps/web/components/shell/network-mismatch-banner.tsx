'use client';

import { ShieldWarningIcon } from '@phosphor-icons/react';
import { useNetworkCheck } from '@/lib/hooks/use-network-check';

/** The DD 7.2 reason every funding and cancel control shows while the networks differ. */
export const mismatchReason = (web: string, api: string): string =>
  `AtPrice is misconfigured: this page is on ${web} but the server is on ${api}. Orders are paused.`;

/**
 * DD 7.13 "Network mismatch": a full-width error banner under the header on every app-shell page when
 * the web build and `GET /api/v1/network` disagree. Blocking: screens disable every funding and cancel
 * action with `mismatchReason` (read `useNetworkCheck()` for the state).
 */
export function NetworkMismatchBanner() {
  const check = useNetworkCheck();
  if (check.status !== 'mismatch') return null;
  return (
    <div role="alert" className="border-b border-border bg-status-failed-subtle">
      <div className="mx-auto flex max-w-(--container-app) items-start gap-3 px-(--space-gutter) py-3 text-body-sm text-fg-secondary md:px-(--space-gutter-md) lg:px-(--space-gutter-lg)">
        <ShieldWarningIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-status-failed" />
        <p>
          <span className="font-semibold text-fg">Network mismatch. </span>
          {mismatchReason(check.web, check.api)}{' '}
          <span className="hash text-mono-sm text-fg">NETWORK_MISMATCH</span>
        </p>
      </div>
    </div>
  );
}
