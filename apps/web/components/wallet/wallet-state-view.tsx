'use client';

import { ShieldWarningIcon, WarningIcon } from '@phosphor-icons/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { formatElapsed } from '@/lib/format';
import { useElapsed } from '@/lib/hooks/use-now';
import { useIsMdUp } from '@/lib/hooks/use-media-query';
import { appNetwork } from '@/lib/network';
import { wrongNetworkCopy, type WalletState } from '@/lib/wallet/connector';
import { getWalletConnector } from '@/lib/wallet/store';
import { closeWalletPanel } from '@/lib/wallet/ui-store';
import { DisabledReason, InlineAlert } from '../states';
import { Button } from '../ui/button';
import { PairingCode } from './pairing';
import { WalletDetails } from './wallet-details';

export type WalletViewMode = 'modal' | 'panel' | 'page';

export const INTRO =
  'AtPrice uses WizardConnect. Scan with a WizardConnect-compatible Bitcoin Cash wallet. AtPrice never asks for your seed phrase or private key.';

/** wallet.md "Copy": one heading per state; focus moves to it on every state change. */
export const stateHeading = (state: WalletState): string | null => {
  switch (state.kind) {
    case 'connected':
      return state.reconnectingSince === null ? 'Connected' : 'Reconnecting';
    case 'wrong_network':
      return 'Wrong network';
    case 'missing_receive':
      return 'This wallet can’t own orders';
    case 'disconnected':
      return state.byUser ? null : 'Disconnected from your wallet';
    case 'pairing_timed_out':
      return 'Pairing stopped';
    case 'error':
      return 'Couldn’t connect';
    case 'resuming':
      return state.notAnswering ? 'Wallet not answering' : 'Resuming wallet session';
    case 'loading':
    case 'unavailable':
    case 'idle':
    case 'pairing':
      return null;
  }
};

const run = (action: () => Promise<void>) => () => {
  action().catch((error: unknown) => console.error('Wallet action failed:', error));
};

function DisconnectBlock() {
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        onClick={run(async () => {
          await getWalletConnector().disconnect();
          closeWalletPanel();
        })}
        className="self-start"
      >
        Disconnect
      </Button>
      <p className="text-body-sm text-fg-muted">
        Disconnecting doesn’t affect your open orders. They stay on chain and keep being watched.
      </p>
    </div>
  );
}

function ReconnectingLine({ since }: { since: number }) {
  const elapsed = useElapsed(since);
  return (
    <InlineAlert tone="warning">
      <p>
        Reconnecting to your wallet (
        <span className="num">{elapsed === null ? '0:00' : formatElapsed(elapsed)}</span>). Requests resume
        when it answers.
      </p>
    </InlineAlert>
  );
}

function ShowPairingCode({ state }: { state: WalletState }) {
  const unavailable = state.kind === 'unavailable';
  const loading = state.kind === 'loading';
  const reasonId = 'show-pairing-code-reason';
  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={run(() => getWalletConnector().connect())}
        aria-disabled={unavailable || loading || undefined}
        aria-describedby={unavailable || loading ? reasonId : undefined}
        className="self-start"
      >
        Show pairing code
      </Button>
      {unavailable ? (
        <DisabledReason id={reasonId}>
          Wallet connection is unavailable in this build (
          <span className="hash">WIZARDCONNECT_UNAVAILABLE</span>): {state.problems.join('; ')}.
        </DisabledReason>
      ) : loading ? (
        <DisabledReason id={reasonId}>Loading the wallet connection library.</DisabledReason>
      ) : null}
    </div>
  );
}

function ResumingBody({ state }: { state: Extract<WalletState, { kind: 'resuming' }> }) {
  const elapsed = useElapsed(state.since);
  const time = elapsed === null ? '0:00' : formatElapsed(elapsed);
  if (!state.notAnswering) {
    return (
      <p className="text-body-sm text-fg-secondary">
        Resuming wallet session · <span className="num">{time}</span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body-sm text-fg-secondary">
        Your saved wallet session hasn’t answered for <span className="num">{time}</span>. Open your wallet
        app to resume it, or forget the session and pair again.
      </p>
      <Button
        variant="outline"
        onClick={run(() => getWalletConnector().forgetAndPair())}
        className="self-start"
      >
        Forget and pair again
      </Button>
    </div>
  );
}

const disconnectMessage = (reason: string | null, message: string | null): ReactNode => {
  if (reason === 'protocol_mismatch')
    return 'Your wallet doesn’t support the hdwalletv1 protocol AtPrice uses.';
  return message;
};

/**
 * Every DD 7.8 pairing state for the connect modal, the wallet panel and `/wallet`. On a state change
 * focus moves to the new state's heading (`tabindex="-1"`, announced once); the "about to stop" notice
 * is not a state change and leaves focus where it is.
 */
export function WalletStateView({
  state,
  mode,
  onDone,
  headingLevel = 'h2',
}: {
  state: WalletState;
  mode: WalletViewMode;
  onDone?: () => void;
  headingLevel?: 'h2' | 'h3' | undefined;
}) {
  const compact = !useIsMdUp();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const heading = stateHeading(state);
  const Heading = headingLevel;
  const shownHeading = useRef(heading);
  useEffect(() => {
    // Only on a change: the dialog's own autofocus (or the page) owns initial focus.
    if (shownHeading.current !== heading && heading !== null) headingRef.current?.focus();
    shownHeading.current = heading;
  }, [heading]);

  const headingNode =
    heading === null ? null : (
      <Heading ref={headingRef} tabIndex={-1} className="font-display text-heading-3 text-fg">
        {heading}
      </Heading>
    );

  switch (state.kind) {
    case 'loading':
    case 'unavailable':
    case 'idle':
      return (
        <div className="flex flex-col gap-4">
          {mode === 'page' ? <p className="max-w-[64ch] text-body text-fg-secondary">{INTRO}</p> : null}
          <ShowPairingCode state={state} />
        </div>
      );
    case 'disconnected':
      return (
        <div className="flex flex-col gap-4">
          {headingNode}
          {state.byUser ? (
            mode === 'page' ? (
              <p className="max-w-[64ch] text-body text-fg-secondary">{INTRO}</p>
            ) : null
          ) : (
            <div className="flex flex-col gap-2 text-body-sm text-fg-secondary">
              <p>Disconnected from your wallet.</p>
              {disconnectMessage(state.reason, state.message) === null ? null : (
                <p>{disconnectMessage(state.reason, state.message)}</p>
              )}
              {state.reason === null ? null : <p className="hash text-mono-sm text-fg">{state.reason}</p>}
            </div>
          )}
          {state.byUser ? (
            <ShowPairingCode state={state} />
          ) : (
            <Button onClick={run(() => getWalletConnector().connect())} className="self-start">
              Connect again
            </Button>
          )}
        </div>
      );
    case 'pairing':
      return <PairingCode state={state} compact={compact} />;
    case 'pairing_timed_out':
      return (
        <div className="flex flex-col gap-4">
          {headingNode}
          <p className="text-body-sm text-fg-secondary">
            AtPrice stopped waiting for a scan. That code no longer works.
          </p>
          <Button onClick={run(() => getWalletConnector().connect())} className="self-start">
            New pairing code
          </Button>
        </div>
      );
    case 'error':
      return (
        <div className="flex flex-col gap-4">
          {headingNode}
          <InlineAlert tone="error" role="alert" title={`Couldn’t connect: ${state.message}`}>
            <p className="hash text-mono-sm text-fg">WIZARDCONNECT_ERROR</p>
          </InlineAlert>
          <Button onClick={run(() => getWalletConnector().connect())} className="self-start">
            Try again
          </Button>
        </div>
      );
    case 'resuming':
      return (
        <div className="flex flex-col gap-4">
          {headingNode}
          <ResumingBody state={state} />
          {state.notAnswering ? <DisconnectBlock /> : null}
        </div>
      );
    case 'wrong_network':
      return (
        <div className="flex flex-col gap-4">
          {headingNode}
          {state.reconnectingSince === null ? null : <ReconnectingLine since={state.reconnectingSince} />}
          <InlineAlert tone="warning" icon={ShieldWarningIcon}>
            <p>{wrongNetworkCopy(state.walletNetwork, appNetwork)}</p>
          </InlineAlert>
          <DisconnectBlock />
        </div>
      );
    case 'missing_receive':
      return (
        <div className="flex flex-col gap-4">
          {headingNode}
          {state.reconnectingSince === null ? null : <ReconnectingLine since={state.reconnectingSince} />}
          <InlineAlert tone="warning" icon={WarningIcon}>
            <p>
              Your wallet didn’t share the receive key path that AtPrice uses to own orders. AtPrice can’t
              place or cancel orders with this wallet.
            </p>
          </InlineAlert>
          <DisconnectBlock />
        </div>
      );
    case 'connected':
      return (
        <div className="flex flex-col gap-5">
          {headingNode}
          {state.reconnectingSince === null ? null : <ReconnectingLine since={state.reconnectingSince} />}
          <WalletDetails wallet={state.wallet} owner={state.owner} />
          {mode === 'modal' ? (
            <Button onClick={onDone} className="self-start">
              Done
            </Button>
          ) : (
            <DisconnectBlock />
          )}
        </div>
      );
  }
}
