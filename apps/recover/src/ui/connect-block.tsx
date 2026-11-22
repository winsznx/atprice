import type { Network } from '@atprice/core';
import { bytesEqual } from '@atprice/core';
import { binToHex } from '@bitauth/libauth';
import { HourglassMediumIcon } from '@phosphor-icons/react/dist/ssr';
import { useRef, type ReactNode } from 'react';
import { formatElapsed } from '../../../web/lib/format';
import { walletNetworkLabel } from '../../../web/lib/wallet/keys';
import { spokenGroups } from '../core/describe';
import type { RecoverWallet, RecoverWalletState } from '../wallet/session';
import { useElapsed, useFocusOnChange, useIsMdUp, useNow } from './hooks';
import { Badge, Button, buttonClass, HashChip, QrCode } from './primitives';

type Pairing = Extract<RecoverWalletState, { kind: 'pairing' }>;

export const QR_LABEL = "Pairing code for WizardConnect. Use Copy link if you can't scan.";

const shortUri = (uri: string): string => (uri.length <= 24 ? uri : `${uri.slice(0, 12)}…${uri.slice(-6)}`);

/** Whether the connected wallet's `receive/0` key hash is the order's owner (DD 7.13 permission). */
export const isOwnerWallet = (state: RecoverWalletState, ownerPkh: Uint8Array): boolean =>
  state.kind === 'connected' && bytesEqual(state.owner.ownerPkh, ownerPkh);

/** The status heading of each DD 7.8 state as recover.md "States, rendered inline" names it. */
export const connectHeading = (state: RecoverWalletState, ownerPkh: Uint8Array): string => {
  switch (state.kind) {
    case 'loading':
      return 'Connect the owner wallet';
    case 'unavailable':
      return "Couldn't connect";
    case 'idle':
      return 'Connect the owner wallet';
    case 'pairing':
      return 'Pair the wallet that created this order';
    case 'pairing_timed_out':
      return 'Pairing stopped';
    case 'connected':
      if (state.reconnectingSince !== null) return 'Reconnecting';
      return isOwnerWallet(state, ownerPkh) ? 'Owner wallet connected' : "This wallet isn't the owner";
    case 'wrong_network':
      return state.reconnectingSince !== null ? 'Reconnecting' : 'Wrong network';
    case 'missing_receive':
      return state.reconnectingSince !== null ? 'Reconnecting' : "This wallet can't sign this cancel";
    case 'disconnected':
      return 'Disconnected from your wallet';
    case 'error':
      return "Couldn't connect";
  }
};

function PairingBlock({ state, wallet }: { state: Pairing; wallet: RecoverWallet }) {
  const mdUp = useIsMdUp();
  const elapsed = useElapsed(state.shownAt) ?? 0;
  const now = useNow();
  const waitingRef = useRef<HTMLParagraphElement>(null);
  const remaining = Math.max(0, state.deadline - now);
  const keepWaiting = () => {
    wallet.keepWaiting();
    waitingRef.current?.focus();
  };
  const qr = <QrCode value={state.qrUri} size={232} label={QR_LABEL} />;
  const uriChip = (
    <HashChip value={state.uri} kind="link" display={shortUri(state.uri)} copyLabel="Copy pairing link" />
  );
  const openLink = (
    <a
      href={state.uri}
      aria-label="Open pairing link in your wallet app"
      className={mdUp ? 'self-start text-body text-link underline underline-offset-4' : buttonClass('primary')}
    >
      Open in wallet app
    </a>
  );
  return (
    <div className="flex flex-col gap-4">
      {mdUp ? (
        <>
          <div className="flex flex-wrap items-start gap-4">
            {qr}
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-body-sm text-fg-secondary">
              <li>Open your wallet app</li>
              <li>Scan this code</li>
              <li>Approve in the wallet</li>
            </ol>
          </div>
          {uriChip}
          {openLink}
        </>
      ) : (
        <>
          {openLink}
          <p className="text-body-sm text-fg-muted">or scan from another device:</p>
          <div className="self-center">{qr}</div>
          {uriChip}
        </>
      )}
      <p ref={waitingRef} tabIndex={-1} className="text-body-sm text-fg-secondary">
        {mdUp ? 'Waiting for your wallet to scan this code' : 'Waiting for your wallet'} ·{' '}
        <span className="num">{formatElapsed(elapsed)}</span>. This page stops waiting after 5 minutes unless you ask for
        more time.
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {state.warningSince === null ? '' : 'This page stops waiting in 0:30.'}
      </p>
      {state.warningSince === null ? null : (
        <div className="flex flex-col gap-3 rounded-md bg-status-pending-subtle p-4 md:flex-row md:items-center md:justify-between">
          <p className="flex items-start gap-2 text-body-sm text-fg-secondary">
            <HourglassMediumIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-status-pending" />
            <span aria-hidden="true">
              This page stops waiting in <span className="num">{formatElapsed(remaining)}</span>.
            </span>
          </p>
          <Button variant="outline" compact onClick={keepWaiting}>
            Keep waiting
          </Button>
        </div>
      )}
      <Button variant="outline" className="self-start" onClick={() => void wallet.cancelPairing()}>
        Cancel pairing
      </Button>
    </div>
  );
}

function Reconnecting({ since }: { since: number }) {
  const elapsed = useElapsed(since) ?? 0;
  return (
    <p className="text-body-sm text-fg-secondary">
      Reconnecting to your wallet (<span className="num">{formatElapsed(elapsed)}</span>). Requests resume when it
      answers.
    </p>
  );
}

const disconnectedText = (reason: string, message: string | null): ReactNode =>
  reason === 'protocol_mismatch' ? (
    "Your wallet doesn't support the hdwalletv1 protocol AtPrice uses."
  ) : (
    <>
      Disconnected from your wallet.{message === null ? '' : ` ${message}`}{' '}
      <span className="hash text-mono-sm">{reason}</span>
    </>
  );

/**
 * The inline pairing block at the top of step 4 (recover.md "Connect (section 4)"). Every state change
 * moves focus to its status heading, which is announced once and is not also a live region.
 */
export function ConnectBlock({
  wallet,
  state,
  ownerPkh,
  network,
}: {
  wallet: RecoverWallet;
  state: RecoverWalletState;
  ownerPkh: Uint8Array;
  network: Network;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const heading = connectHeading(state, ownerPkh);
  useFocusOnChange(headingRef, `${state.kind}:${heading}`);
  const disconnect = (
    <Button variant="outline" compact className="self-start" onClick={() => void wallet.disconnect()}>
      Disconnect
    </Button>
  );
  const connect = (label: string) => (
    <Button className="self-start" onClick={() => void wallet.connect()}>
      {label}
    </Button>
  );
  const reconnectingSince =
    state.kind === 'connected' || state.kind === 'wrong_network' || state.kind === 'missing_receive'
      ? state.reconnectingSince
      : null;

  let body: ReactNode;
  switch (state.kind) {
    case 'loading':
    case 'idle':
      body = (
        <>
          <p className="text-body-sm text-fg-secondary">
            This page uses WizardConnect to ask the wallet that created this order to sign the cancel. It never asks for a
            seed phrase or private key.
          </p>
          {connect('Connect owner wallet')}
        </>
      );
      break;
    case 'unavailable':
      body = (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-status-failed bg-status-failed-subtle p-4">
          <p className="text-body-sm text-fg">
            The wallet connection library in this file failed its start-up check: {state.problems.join('; ')}. Use{' '}
            <a href="#other-ways" className="text-link underline underline-offset-4">
              Other ways
            </a>{' '}
            below.
          </p>
          <p className="hash text-mono-sm text-status-failed">WIZARDCONNECT_UNAVAILABLE</p>
        </div>
      );
      break;
    case 'pairing':
      body = <PairingBlock state={state} wallet={wallet} />;
      break;
    case 'pairing_timed_out':
      body = (
        <>
          <p className="text-body-sm text-fg-secondary">This page stopped waiting for a scan. That code no longer works.</p>
          {connect('New pairing code')}
        </>
      );
      break;
    case 'connected': {
      const hex = binToHex(ownerPkh);
      body = (
        <>
          {reconnectingSince !== null ? <Reconnecting since={reconnectingSince} /> : null}
          {isOwnerWallet(state, ownerPkh) ? (
            <p className="flex flex-wrap items-center gap-2 text-body-sm text-fg-secondary">
              <Badge tone="filled">Connected</Badge>
              <span className="text-fg">{state.wallet.name}</span>
              <span>· owner key hash matches</span>
              <HashChip value={hex} kind="keyhash" label={`Owner key hash ${spokenGroups(hex)}`} />
            </p>
          ) : (
            <p className="text-body-sm text-fg-secondary">
              This wallet isn't the owner. The order was created by key hash{' '}
              <span className="hash text-mono-sm text-fg">{spokenGroups(hex).split(' ').slice(0, 2).join(' ')} …</span>
              <span className="sr-only">{spokenGroups(hex)}</span>. Connect the wallet that created it.
            </p>
          )}
          {disconnect}
        </>
      );
      break;
    }
    case 'wrong_network':
      body = (
        <>
          {reconnectingSince !== null ? <Reconnecting since={reconnectingSince} /> : null}
          <p className="text-body-sm text-fg-secondary">
            Your wallet is on {walletNetworkLabel(state.walletNetwork)}. This file recovers {network} orders. Switch your
            wallet, then connect again.
          </p>
          {disconnect}
        </>
      );
      break;
    case 'missing_receive':
      body = (
        <>
          {reconnectingSince !== null ? <Reconnecting since={reconnectingSince} /> : null}
          <p className="text-body-sm text-fg-secondary">
            Your wallet didn't share the receive key path that owns AtPrice orders, so it can't sign this cancel.
          </p>
          {disconnect}
        </>
      );
      break;
    case 'disconnected':
      body = (
        <>
          <p className="text-body-sm text-fg-secondary">{disconnectedText(state.reason, state.message)}</p>
          {connect('Connect again')}
        </>
      );
      break;
    case 'error':
      body = (
        <>
          <div role="alert" className="flex flex-col gap-2 rounded-md border border-status-failed bg-status-failed-subtle p-4">
            {state.relayUnreachable ? (
              <p className="text-body-sm text-fg">
                Couldn't reach the wallet connection relay ({state.message}). You can still cancel from{' '}
                <a href="#other-ways" className="text-link underline underline-offset-4">
                  Other ways
                </a>
                .
              </p>
            ) : (
              <p className="text-body-sm text-fg">Couldn't connect: {state.message}</p>
            )}
            <p className="hash text-mono-sm text-status-failed">
              {state.relayUnreachable ? 'WIZARDCONNECT_UNAVAILABLE' : 'WIZARDCONNECT_ERROR'}
            </p>
          </div>
          {connect('Try again')}
        </>
      );
      break;
  }

  return (
    <section aria-labelledby="connect-status" className="flex flex-col gap-3 rounded-lg border border-border p-4 md:p-5">
      <p className="text-label text-fg-muted">Wallet</p>
      <h3 id="connect-status" ref={headingRef} tabIndex={-1} className="text-label font-semibold text-fg">
        {heading}
      </h3>
      {body}
    </section>
  );
}
