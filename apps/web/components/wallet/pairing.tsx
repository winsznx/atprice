'use client';

import { HourglassMediumIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { formatElapsed } from '@/lib/format';
import { useElapsed, useNow } from '@/lib/hooks/use-now';
import type { WalletState } from '@/lib/wallet/connector';
import { DEEP_LINK_FALLBACK_MS } from '@/lib/wallet/constants';
import { getWalletConnector } from '@/lib/wallet/store';
import { cn } from '@/lib/utils';
import { QrCode } from '../qr-code';
import { Button, buttonVariants } from '../ui/button';
import { CopyField } from './copy-field';

type PairingState = Extract<WalletState, { kind: 'pairing' }>;

const shortUri = (uri: string): string => (uri.length <= 24 ? uri : `${uri.slice(0, 12)}…${uri.slice(-6)}`);

/** `Open in wallet app`, with the "no wallet app opened" line after 2 s of the page staying visible. */
function OpenInWallet({ uri, primary }: { uri: string; primary: boolean }) {
  const [noHandler, setNoHandler] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = () => {
    setNoHandler(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (document.visibilityState === 'visible') setNoHandler(true);
    }, DEEP_LINK_FALLBACK_MS);
  };
  return (
    <div className="flex flex-col gap-1">
      <a
        href={uri}
        onClick={onClick}
        className={cn(
          primary ? buttonVariants({ variant: 'primary' }) : 'text-link underline underline-offset-4',
          'self-start',
        )}
      >
        Open in wallet app
      </a>
      {noHandler ? (
        <p role="status" className="text-body-sm text-fg-muted">
          No wallet app opened. Scan the code from another device instead.
        </p>
      ) : null}
    </div>
  );
}

/** "Pairing code shown" and "pairing about to stop" (DD 7.8, wallet.md wireframes). */
export function PairingCode({ state, compact }: { state: PairingState; compact: boolean }) {
  const elapsed = useElapsed(state.shownAt);
  const now = useNow();
  const waitingRef = useRef<HTMLParagraphElement>(null);
  const remaining = now === null ? null : Math.max(0, state.deadline - now);

  const keepWaiting = () => {
    getWalletConnector().keepWaiting();
    // The button leaves with the notice; focus goes to the waiting line, never to body (wallet.md).
    waitingRef.current?.focus();
  };

  const qr = (
    <QrCode
      value={state.qrUri}
      size={compact ? 232 : 256}
      label="Pairing code for WizardConnect. Use Copy link if you can't scan."
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {compact ? (
        <>
          <OpenInWallet uri={state.uri} primary />
          <p className="text-body-sm text-fg-muted">or scan from another device:</p>
          <div className="self-center">{qr}</div>
          <CopyField
            value={state.uri}
            shown={shortUri(state.uri)}
            copyLabel="Copy pairing link"
            buttonText="Copy link"
          />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-4">
            {qr}
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-body-sm text-fg-secondary">
              <li>Open your wallet app</li>
              <li>Scan this code</li>
              <li>Approve in the wallet</li>
            </ol>
          </div>
          <CopyField
            value={state.uri}
            shown={shortUri(state.uri)}
            copyLabel="Copy pairing link"
            buttonText="Copy link"
          />
          <OpenInWallet uri={state.uri} primary={false} />
        </>
      )}
      <p ref={waitingRef} tabIndex={-1} className="text-body-sm text-fg-secondary">
        {compact ? 'Waiting for your wallet' : 'Waiting for your wallet to scan this code'}
        {elapsed === null ? '' : ' · '}
        {elapsed === null ? null : <span className="num">{formatElapsed(elapsed)}</span>}. AtPrice stops
        waiting after 5 minutes unless you ask for more time.
      </p>
      {/* Announced once when the notice appears; the ticking countdown sits outside the live region. */}
      <p role="status" aria-live="polite" className="sr-only">
        {state.warningSince === null ? '' : 'AtPrice stops waiting in 0:30.'}
      </p>
      {state.warningSince === null ? null : (
        <div className="flex flex-col gap-3 rounded-md bg-status-pending-subtle p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-body-sm text-fg-secondary">
            <HourglassMediumIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-status-pending" />
            <span aria-hidden="true">
              AtPrice stops waiting in <span className="num">{formatElapsed(remaining ?? 0)}</span>.
            </span>
          </p>
          <Button variant="outline" onClick={keepWaiting} className={compact ? 'w-full' : undefined}>
            Keep waiting
          </Button>
        </div>
      )}
    </div>
  );
}
