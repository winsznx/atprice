'use client';

import { ShieldWarningIcon, WarningIcon } from '@phosphor-icons/react';
import { useRef, type ComponentProps } from 'react';
import { formatBch, formatElapsed, formatElapsedSpoken, truncateMiddle } from '@/lib/format';
import { useElapsed } from '@/lib/hooks/use-now';
import type { WalletState } from '@/lib/wallet/connector';
import { ownerOf, useWalletScan, useWalletState } from '@/lib/wallet/store';
import { openConnectModal, openWalletPanel, type ReturnFocus } from '@/lib/wallet/ui-store';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';

const opensConnect = (state: WalletState): boolean =>
  state.kind === 'loading' ||
  state.kind === 'unavailable' ||
  state.kind === 'idle' ||
  state.kind === 'pairing' ||
  state.kind === 'pairing_timed_out' ||
  state.kind === 'disconnected' ||
  state.kind === 'error';

const reconnectingSince = (state: WalletState): number | null =>
  state.kind === 'connected' || state.kind === 'wrong_network' || state.kind === 'missing_receive'
    ? state.reconnectingSince
    : null;

/**
 * The header wallet button (DD 8): one `<button>` element in every state with a stable identity, so
 * the node that opened the connect modal is still there to take focus back when it closes.
 */
export function WalletButton({ className }: { className?: string | undefined }) {
  const state = useWalletState();
  const owner = ownerOf(state);
  const scan = useWalletScan(owner);
  const ref = useRef<HTMLButtonElement>(null);
  const since = state.kind === 'resuming' ? state.since : reconnectingSince(state);
  const elapsed = useElapsed(since);
  const time = elapsed === null ? '0:00' : formatElapsed(elapsed);
  const spokenTime = elapsed === null ? '0 minutes 0 seconds' : formatElapsedSpoken(elapsed);

  const connect = opensConnect(state);
  const onClick = () => {
    if (connect) openConnectModal({ trigger: ref.current });
    else openWalletPanel();
  };

  let label: string;
  let spoken: string | undefined;
  let warning = false;
  if (connect) {
    label = 'Connect wallet';
  } else if (state.kind === 'resuming') {
    label = state.notAnswering ? 'Wallet not answering' : `Resuming wallet session · ${time}`;
    spoken = state.notAnswering
      ? 'Wallet not answering, open wallet panel'
      : `Resuming wallet session for ${spokenTime}, open wallet panel`;
  } else if (reconnectingSince(state) !== null) {
    label = `Reconnecting · ${time}`;
    spoken = `Wallet reconnecting for ${spokenTime}, open wallet panel`;
  } else if (state.kind === 'wrong_network') {
    label = 'Wrong network';
    spoken = 'Wallet on the wrong network, open wallet panel';
    warning = true;
  } else if (state.kind === 'missing_receive') {
    label = 'Wallet can’t own orders';
    spoken = 'Wallet can’t own orders, open wallet panel';
    warning = true;
  } else if (owner !== null) {
    const short = truncateMiddle(owner.address, 4, 2);
    const balance = scan.data === undefined ? null : `${formatBch(scan.data.bchSats, 'compact')} BCH`;
    label = balance === null ? short : `${short} · ${balance}`;
    spoken = `Wallet, ${short}${balance === null ? '' : `, ${balance}`}, open wallet panel`;
  } else {
    label = 'Connect wallet';
  }

  return (
    <Button
      ref={ref}
      size="compact"
      onClick={onClick}
      aria-label={spoken}
      aria-busy={state.kind === 'resuming' && !state.notAnswering ? true : undefined}
      variant={connect ? 'primary' : 'outline'}
      className={cn(
        'max-w-[12.5rem] whitespace-normal text-center',
        warning &&
          'border-status-pending bg-status-pending-subtle text-status-pending hover:bg-status-pending-subtle',
        className,
      )}
    >
      {warning ? (
        state.kind === 'wrong_network' ? (
          <ShieldWarningIcon aria-hidden="true" className="size-4" />
        ) : (
          <WarningIcon aria-hidden="true" className="size-4" />
        )
      ) : null}
      <span className={cn(!connect && 'num')}>{label}</span>
    </Button>
  );
}

/**
 * A `Connect wallet` trigger for screens. `fallback` names the element that takes focus if this button
 * is gone when the modal closes (wallet.md entry-point table). Use the same element across states
 * where the spec says the trigger becomes another control (the trade ticket's `Review order`).
 */
export function ConnectWalletButton({
  fallback,
  className,
  variant = 'primary',
  size,
  children = 'Connect wallet',
}: {
  fallback?: ReturnFocus['fallback'] | undefined;
  className?: string | undefined;
  variant?: ComponentProps<typeof Button>['variant'] | undefined;
  size?: ComponentProps<typeof Button>['size'] | undefined;
  children?: string | undefined;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      className={className}
      onClick={() =>
        openConnectModal(
          fallback === undefined ? { trigger: ref.current } : { trigger: ref.current, fallback },
        )
      }
    >
      {children}
    </Button>
  );
}
