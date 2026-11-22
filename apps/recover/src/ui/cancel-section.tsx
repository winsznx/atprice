import type { SignedTransaction } from '@atprice/core';
import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { formatBlockHeight, formatElapsed } from '../../../web/lib/format';
import { isWalletError } from '../../../web/lib/wallet/errors';
import { walletNetworkLabel } from '../../../web/lib/wallet/keys';
import type { RecoverConfig } from '../config';
import { broadcastCancel, serverHasTransaction } from '../core/broadcast';
import {
  cancelBuildInvalidMessage,
  CancelCheckError,
  checkSignedCancel,
  planCancel,
  supportsPlaceholderSigning,
  type BuiltCancel,
  type CancelPath,
  type CancelPlan,
} from '../core/cancel';
import { bchText, feeText, heldLines, ownerAddressOf } from '../core/describe';
import { describeError, errorCode } from '../core/errors';
import { confirmationsAt, readOrderStatus, type LoadedOrder } from '../core/lookup';
import { recoverNetworkProvider } from '../core/provider';
import type { ServerState } from '../core/server-session';
import type { RecoverWallet, RecoverWalletState } from '../wallet/session';
import { ConnectBlock, isOwnerWallet } from './connect-block';
import { addressExplorer, txExplorer } from './explorer';
import { useElapsed, useFocusOnChange } from './hooks';
import { Button, DisabledReason, ErrorBlock, HashChip, QrCode, Row } from './primitives';
import { SectionHeading } from './section';
import { useOwnerCoins, type OwnerCoins } from './use-owner-coins';

export type Flow =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'awaiting'; readonly since: number; readonly controller: AbortController }
  | { readonly kind: 'declined'; readonly message: string }
  | { readonly kind: 'request_cancelled' }
  | { readonly kind: 'session_ended' }
  | { readonly kind: 'invalid'; readonly rule: string }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'broadcasting'; readonly since: number; readonly signed: SignedTransaction }
  | { readonly kind: 'unknown'; readonly signed: SignedTransaction; readonly detail: string; readonly notFound: boolean }
  | { readonly kind: 'rejected'; readonly detail: string };

const BUILDING = 'Building the cancel';

/** Called from event handlers only; kept out of the component body for the React purity lint. */
const timestamp = (): number => Date.now();

const BUSY: readonly Flow['kind'][] = ['checking', 'awaiting', 'broadcasting', 'unknown'];

/** The first reason `Sign cancel in wallet` can't run, or null (recover.md "Controls"). */
export const signBlocker = (options: {
  server: ServerState;
  wallet: RecoverWalletState;
  ownerMatches: boolean;
  plan: CancelPlan | null;
  network: RecoverConfig['network'];
  reconnectElapsed: string;
}): string | null => {
  const { server, wallet, plan } = options;
  if (server.kind !== 'connected') return 'Connect to a server first.';
  if (server.lost) return `The connection to ${server.host} dropped. Signing waits until it is back.`;
  if (wallet.kind === 'wrong_network') {
    return `Your wallet is on ${walletNetworkLabel(wallet.walletNetwork)}. This file recovers ${options.network} orders. Switch your wallet, then connect again.`;
  }
  if (wallet.kind === 'missing_receive') {
    return "Your wallet didn't share the receive key path that owns AtPrice orders, so it can't sign this cancel.";
  }
  if (wallet.kind !== 'connected') return 'Connect the owner wallet first.';
  if (wallet.reconnectingSince !== null) {
    return `Reconnecting to your wallet (${options.reconnectElapsed}). Requests resume when it answers.`;
  }
  if (!options.ownerMatches) return "This wallet isn't the owner. Connect the wallet that created this order.";
  if (plan === null) return 'Building the cancel.';
  if (plan.kind === 'invalid') return "The cancel failed a safety check, so it can't be signed.";
  return null;
};

/** The cancel status heading; each change moves focus to it (cancel-confirmation.md). */
export const cancelHeading = (coins: OwnerCoins, plan: CancelPlan | null, flow: Flow, sent: SentState | null): string => {
  if (sent !== null) return sent.height > 0 ? 'Cancelled' : 'Cancel sent';
  switch (flow.kind) {
    case 'checking':
      return 'Checking the order is still open';
    case 'awaiting':
      return 'Approve the cancel in your wallet';
    case 'declined':
      return 'Your wallet declined the cancel';
    case 'request_cancelled':
      return 'Request cancelled';
    case 'session_ended':
      return 'The wallet session ended';
    case 'invalid':
      return 'The cancel failed a safety check';
    case 'failed':
      return "Couldn't send the cancel";
    case 'broadcasting':
      return 'Sending the cancel';
    case 'unknown':
      return 'Broadcast not confirmed';
    case 'rejected':
      return 'The server rejected the cancel';
    case 'idle':
      break;
  }
  if (coins.kind === 'error') return "Couldn't read the owner address";
  if (plan === null) return BUILDING;
  if (plan.kind === 'no_owner_utxo') return 'The owner wallet needs a coin';
  if (plan.kind === 'invalid') return 'The cancel failed a safety check';
  return 'Ready to cancel';
};

export interface SentState {
  readonly txid: string;
  /** Height of the cancel, 0 or below while in the mempool. */
  readonly height: number;
}

function Elapsed({ since }: { since: number }) {
  const elapsed = useElapsed(since) ?? 0;
  return <span className="num">{formatElapsed(elapsed)}</span>;
}

/** The cancel this page built, before signing (cancel-confirmation.md layout, inline). */
function BuiltRows({ order, built }: { order: LoadedOrder; built: BuiltCancel }) {
  const ownerAddress = ownerAddressOf(order.record.ownerPkh, order.network);
  return (
    <dl className="flex flex-col divide-y divide-border">
      <Row label="You get back">
        {heldLines(order, built.refund).map((line) => (
          <span key={line} className="num text-num-md">
            {line}
          </span>
        ))}
        <span className="flex flex-wrap items-center gap-2 text-body-sm text-fg-secondary">
          to <HashChip value={ownerAddress} kind="address" explorer={addressExplorer(order.network, ownerAddress)} />
        </span>
      </Row>
      <Row label="Network fee">
        <span className="num">{feeText(built.fee)}</span>
        <span className="text-body-sm text-fg-secondary">
          at <span className="num">{built.feePerByte.toString()}</span> sat/byte, the network's minimum relay fee, for{' '}
          <span className="num">{built.size.toLocaleString('en-US')}</span> bytes. It comes out of the order's fee cap.
        </span>
      </Row>
      <Row label="Authorized by">
        {built.ownerCoin === null ? (
          <span>The owner wallet's signature inside the contract</span>
        ) : (
          <>
            <span>A coin at the owner address</span>
            <span className="text-body-sm text-fg-secondary">
              <span className="num">{bchText(built.ownerCoin.satoshis)}</span>, returned to the same address in the same
              transaction.
            </span>
          </>
        )}
      </Row>
    </dl>
  );
}

function NoOwnerCoin({
  order,
  plan,
  coins,
  walletName,
  canSignInContract,
  onCheckAgain,
  onSignInContract,
}: {
  order: LoadedOrder;
  plan: Extract<CancelPlan, { kind: 'no_owner_utxo' }>;
  coins: OwnerCoins;
  walletName: string | null;
  canSignInContract: boolean;
  onCheckAgain: () => void;
  onSignInContract: () => void;
}) {
  const ownerAddress = ownerAddressOf(order.record.ownerPkh, order.network);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body-sm text-fg-secondary">
        The owner wallet needs a coin at{' '}
        <HashChip value={ownerAddress} kind="address" explorer={addressExplorer(order.network, ownerAddress)} /> before
        it can cancel. Send at least <span className="num">{feeText(plan.askSatoshis)}</span> to it from any wallet. This
        page will notice the payment and continue.
      </p>
      <details>
        <summary className="flex min-h-11 cursor-pointer items-center text-body text-link underline underline-offset-4">
          Show QR
        </summary>
        <div className="pt-2">
          <QrCode value={ownerAddress} size={232} label={`QR code of the owner address ${ownerAddress}`} />
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" compact onClick={onCheckAgain}>
          Check again
        </Button>
        {coins.kind === 'ready' ? (
          <span className="text-body-sm text-fg-secondary">
            Waiting · <Elapsed since={coins.since} />
          </span>
        ) : null}
      </div>
      {canSignInContract && walletName !== null ? (
        <Button variant="outline" className="self-start" onClick={onSignInContract}>
          Sign inside the contract with {walletName}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Step 4 of 4: pair the owner wallet inline, build the cancel with `packages/core`, sign, broadcast to
 * the chosen server and report the honest outcome.
 */
export function CancelSection({
  config,
  order,
  server,
  wallet,
  walletState,
  coins,
  checkAgain,
  plan,
  path,
  onPathChange,
  sent,
  onOrderChanged,
  onCancelSent,
  onPickServer,
  headingRef,
}: {
  config: RecoverConfig;
  order: LoadedOrder;
  server: ServerState;
  wallet: RecoverWallet;
  walletState: RecoverWalletState;
  coins: OwnerCoins;
  checkAgain: () => void;
  plan: CancelPlan | null;
  path: CancelPath;
  onPathChange: (path: CancelPath) => void;
  sent: SentState | null;
  onOrderChanged: (order: LoadedOrder) => void;
  onCancelSent: (txid: string) => void;
  onPickServer: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const statusRef = useRef<HTMLHeadingElement>(null);
  const reasonId = 'sign-reason';
  const ownerMatches = isOwnerWallet(walletState, order.record.ownerPkh);
  const reconnectSince = walletState.kind === 'connected' ? walletState.reconnectingSince : null;
  const reconnectElapsed = useElapsed(reconnectSince);
  const heading = cancelHeading(coins, plan, flow, sent);
  useFocusOnChange(statusRef, heading, BUILDING);
  const chain = server.kind === 'connected' ? server.chain : null;
  const host = server.kind === 'idle' ? '' : server.host;
  const busy = BUSY.includes(flow.kind);
  const blocker =
    busy
      ? null
      : signBlocker({
          server,
          wallet: walletState,
          ownerMatches,
          plan,
          network: config.network,
          reconnectElapsed: formatElapsed(reconnectElapsed ?? 0),
        });

  const broadcast = async (signed: SignedTransaction) => {
    if (chain === null) return;
    setFlow({ kind: 'broadcasting', since: timestamp(), signed });
    const outcome = await broadcastCancel(chain, signed);
    if (outcome.kind === 'accepted') {
      setFlow({ kind: 'idle' });
      onCancelSent(outcome.txid);
      return;
    }
    if (outcome.kind === 'unknown') {
      setFlow({ kind: 'unknown', signed, detail: outcome.detail, notFound: false });
      return;
    }
    if (outcome.alreadySpent) {
      await recheck();
      return;
    }
    setFlow({ kind: 'rejected', detail: outcome.detail });
  };

  /** Re-reads the order output; a spent one replaces this step with the filled or cancelled view. */
  const recheck = async (): Promise<boolean> => {
    if (chain === null) return false;
    try {
      const { status, fundingHeight } = await readOrderStatus(
        chain,
        order.record,
        order.lockingBytecode,
        order.funding,
        order.fundingOutput,
      );
      if (status.kind !== 'unspent') {
        setFlow({ kind: 'idle' });
        onOrderChanged({ ...order, status, fundingHeight });
        return false;
      }
      return true;
    } catch (error) {
      setFlow({ kind: 'failed', error });
      return false;
    }
  };

  const sign = async () => {
    if (plan?.kind !== 'ready' || chain === null) return;
    const built = plan.cancel;
    setFlow({ kind: 'checking' });
    if (!(await recheck())) return;
    const controller = new AbortController();
    setFlow({ kind: 'awaiting', since: timestamp(), controller });
    let signedHex: string;
    try {
      signedHex = await wallet.requestSignature(built.draft, controller.signal);
    } catch (error) {
      if (isWalletError(error) && error.code === 'WALLET_DECLINED') setFlow({ kind: 'declined', message: error.message });
      else if (isWalletError(error) && error.code === 'SIGN_REQUEST_CANCELLED') setFlow({ kind: 'request_cancelled' });
      else if (isWalletError(error) && error.code === 'WALLET_SESSION_ENDED') setFlow({ kind: 'session_ended' });
      else setFlow({ kind: 'failed', error });
      return;
    }
    let signed: SignedTransaction;
    try {
      signed = checkSignedCancel(built, order, signedHex);
    } catch (error) {
      if (error instanceof CancelCheckError) setFlow({ kind: 'invalid', rule: error.rule });
      else setFlow({ kind: 'failed', error });
      return;
    }
    await broadcast(signed);
  };

  const checkBroadcast = async (unknown: Extract<Flow, { kind: 'unknown' }>) => {
    if (chain === null) return;
    if (await serverHasTransaction(chain, unknown.signed.txid)) {
      setFlow({ kind: 'idle' });
      onCancelSent(unknown.signed.txid);
      return;
    }
    setFlow({ ...unknown, notFound: true });
  };

  let status: ReactNode = null;
  if (sent !== null) {
    status = (
      <div className="flex flex-col gap-2">
        <p className="text-body-sm text-fg-secondary">
          {sent.height > 0 ? (
            <>
              Cancelled. Confirmed in block <span className="num">{formatBlockHeight(sent.height)}</span>
              {server.kind === 'connected' ? (
                <>
                  {' '}
                  (<span className="num">{confirmationsAt(sent.height, server.tip).toLocaleString('en-US')}</span>{' '}
                  confirmations on {server.host})
                </>
              ) : null}
              .
            </>
          ) : (
            'Cancel sent. Not confirmed yet.'
          )}
        </p>
        <HashChip value={sent.txid} kind="tx" explorer={txExplorer(order.network, sent.txid)} />
      </div>
    );
  } else {
    switch (flow.kind) {
      case 'checking':
        status = <p className="text-body-sm text-fg-secondary">Checking on {host} that the order output is still unspent.</p>;
        break;
      case 'awaiting':
        status = (
          <div className="flex flex-col gap-3">
            <p className="text-body-sm text-fg-secondary">
              {reconnectSince !== null ? (
                <>
                  Reconnecting to your wallet (<Elapsed since={reconnectSince} />
                  ). Your request is sent again when it answers.
                </>
              ) : (
                <>
                  Approve the cancel in your wallet · <Elapsed since={flow.since} />. This page waits as long as your wallet
                  takes.
                </>
              )}
            </p>
            <Button variant="outline" className="self-start" onClick={() => flow.controller.abort()}>
              Cancel request
            </Button>
          </div>
        );
        break;
      case 'declined':
        status = (
          <p className="text-body-sm text-fg-secondary">
            Your wallet declined the cancel: {flow.message} Nothing was sent. Your order is unchanged.
          </p>
        );
        break;
      case 'request_cancelled':
        status = <p className="text-body-sm text-fg-secondary">You cancelled the request. Nothing was sent.</p>;
        break;
      case 'session_ended':
        status = (
          <p className="text-body-sm text-fg-secondary">
            The wallet session ended before your wallet answered. Nothing was sent. Connect again to retry.
          </p>
        );
        break;
      case 'invalid':
        status = <ErrorBlock message={cancelBuildInvalidMessage(flow.rule, 'browser')} code="CANCEL_BUILD_INVALID" />;
        break;
      case 'failed':
        status = (
          <ErrorBlock
            message={`Couldn't finish the cancel: ${describeError(flow.error)}. Your order is unchanged unless a cancel was sent.`}
            code={errorCode(flow.error)}
          />
        );
        break;
      case 'broadcasting':
        status = (
          <div className="flex flex-col gap-2">
            <p className="text-body-sm text-fg-secondary">
              Sending to {host} · <Elapsed since={flow.since} />.
            </p>
            <HashChip value={flow.signed.txid} kind="tx" explorer={txExplorer(order.network, flow.signed.txid)} />
          </div>
        );
        break;
      case 'unknown':
        status = (
          <div className="flex flex-col gap-3">
            <p className="text-body-sm text-fg-secondary">
              {host} didn't confirm the broadcast. Cancel <span className="hash">{flow.signed.txid}</span> may or may not
              have reached the network.
            </p>
            <p className="hash text-mono-sm text-fg-muted">{flow.detail}</p>
            {flow.notFound ? (
              <p className="text-body-sm text-fg-secondary">{host} doesn't have this cancel. You can send it again.</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" compact onClick={() => void checkBroadcast(flow)}>
                Check again
              </Button>
              {flow.notFound ? (
                <Button variant="outline" compact onClick={() => void broadcast(flow.signed)}>
                  Broadcast again
                </Button>
              ) : null}
              <Button variant="outline" compact onClick={onPickServer}>
                Pick another server
              </Button>
            </div>
          </div>
        );
        break;
      case 'rejected':
        status = (
          <ErrorBlock message={`${host} rejected the cancel: ${flow.detail}. Your order is unchanged.`} code="BROADCAST_REJECTED" />
        );
        break;
      case 'idle':
        break;
    }
  }

  const walletName = walletState.kind === 'connected' ? walletState.wallet.name : null;

  return (
    <section aria-labelledby="step-cancel" className="flex flex-col gap-4">
      <SectionHeading id="step-cancel" step={4} title="Cancel" headingRef={headingRef} />
      {sent === null ? (
        <ConnectBlock wallet={wallet} state={walletState} ownerPkh={order.record.ownerPkh} network={config.network} />
      ) : null}
      <div className="flex flex-col gap-3">
        <h3 ref={statusRef} tabIndex={-1} className="text-label font-semibold text-fg">
          {heading}
        </h3>
        {sent === null && !busy ? (
          <CancelBody
            order={order}
            coins={coins}
            plan={plan}
            path={path}
            walletName={walletName}
            canSignInContract={ownerMatches && supportsPlaceholderSigning(walletName)}
            onCheckAgain={checkAgain}
            onPathChange={onPathChange}
          />
        ) : null}
        {status}
        {sent === null && plan?.kind !== 'no_owner_utxo' ? (
          <div className="flex flex-col gap-1">
            <Button
              variant="destructive"
              className="self-stretch xs:self-start"
              aria-disabled={blocker !== null || busy || undefined}
              aria-describedby={blocker === null ? undefined : reasonId}
              onClick={() => void sign()}
            >
              Sign cancel in wallet
            </Button>
            {blocker === null ? null : <DisabledReason id={reasonId}>{blocker}</DisabledReason>}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CancelBody({
  order,
  coins,
  plan,
  path,
  walletName,
  canSignInContract,
  onCheckAgain,
  onPathChange,
}: {
  order: LoadedOrder;
  coins: OwnerCoins;
  plan: CancelPlan | null;
  path: CancelPath;
  walletName: string | null;
  canSignInContract: boolean;
  onCheckAgain: () => void;
  onPathChange: (path: CancelPath) => void;
}) {
  if (coins.kind === 'error') {
    return (
      <ErrorBlock
        message={`Couldn't read the coins at the owner address: ${describeError(coins.error)}`}
        code={errorCode(coins.error)}
      >
        <Button variant="outline" compact className="self-start" onClick={onCheckAgain}>
          Check again
        </Button>
      </ErrorBlock>
    );
  }
  if (plan === null) {
    return (
      <p aria-busy="true" className="text-body-sm text-fg-secondary">
        Reading the coins at the owner address.
      </p>
    );
  }
  if (plan.kind === 'no_owner_utxo') {
    return (
      <NoOwnerCoin
        order={order}
        plan={plan}
        coins={coins}
        walletName={walletName}
        canSignInContract={canSignInContract}
        onCheckAgain={onCheckAgain}
        onSignInContract={() => onPathChange('cancelWithSig')}
      />
    );
  }
  if (plan.kind === 'invalid') {
    return (
      <ErrorBlock message={cancelBuildInvalidMessage(plan.rule, 'browser')} code="CANCEL_BUILD_INVALID">
        {path === 'cancelWithSig' ? (
          <Button variant="outline" compact className="self-start" onClick={() => onPathChange('cancel')}>
            Use a coin at the owner address instead
          </Button>
        ) : null}
      </ErrorBlock>
    );
  }
  return <BuiltRows order={order} built={plan.cancel} />;
}

/** The cancel plan for an unspent order, rebuilt whenever the owner coins or the chosen path change. */
export const useCancelPlan = (
  server: ServerState,
  order: LoadedOrder,
): {
  coins: OwnerCoins;
  checkAgain: () => void;
  plan: CancelPlan | null;
  path: CancelPath;
  setPath: (path: CancelPath) => void;
} => {
  const chain = server.kind === 'connected' ? server.chain : null;
  const { coins, checkAgain } = useOwnerCoins(chain, order);
  const [path, setPath] = useState<CancelPath>('cancel');
  const plan = useMemo(() => {
    if (chain === null || order.status.kind !== 'unspent') return null;
    if (path === 'cancel' && coins.kind !== 'ready') return null;
    return planCancel({
      order,
      ownerUtxos: coins.kind === 'ready' ? coins.utxos : [],
      path,
      provider: recoverNetworkProvider(chain, order.network),
    });
  }, [chain, order, coins, path]);
  return { coins, checkAgain, plan, path, setPath };
};
