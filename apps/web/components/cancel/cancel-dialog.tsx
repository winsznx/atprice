'use client';

import { QrCodeIcon, XIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Num } from '@/components/amount';
import { HashChip } from '@/components/hash-chip';
import { QrCode } from '@/components/qr-code';
import { DisabledReason, InlineAlert } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ConnectWalletButton } from '@/components/wallet/wallet-button';
import { mismatchReason } from '@/components/shell/network-mismatch-banner';
import type { Order } from '@/lib/api/schemas';
import { getChain } from '@/lib/chain/client';
import { formatBch, formatElapsed, formatFee } from '@/lib/format';
import { useIsMdUp } from '@/lib/hooks/use-media-query';
import { useNetworkCheck } from '@/lib/hooks/use-network-check';
import { useElapsed } from '@/lib/hooks/use-now';
import { cancelRaceLost, cancelSent, broadcastUnknown } from '@/lib/notifications/messages';
import { getNotificationCenter } from '@/lib/notifications/store';
import { bchText, limitText, orderInputText, receivedText } from '@/lib/orders/display';
import type { OwnerIdentity } from '@/lib/wallet/keys';
import { cn } from '@/lib/utils';
import { sideTitle } from '@/components/orders/order-lists';
import type { BuiltCancel } from './cancel-build';
import { serverCheckText, topUpRequest } from './cancel-rules';
import { placeholderSigningWallet } from '@/lib/wallet/placeholder-wallets';
import { PRE_SIGNING, useCancelFlow, type CancelFlow, type CancelFlowState } from './use-cancel-flow';

export interface CancelWallet {
  /** Null while the wallet is disconnected (or no longer passes the DD 7.8 checks). */
  readonly owner: OwnerIdentity | null;
  readonly walletName: string | null;
  readonly reconnectingSince: number | null;
}

export interface CancelDialogProps {
  readonly open: boolean;
  readonly order: Order;
  readonly wallet: CancelWallet;
  /** Called once the dialog has closed; `changed` is true when the order's state changed in the flow. */
  readonly onClosed: (changed: boolean) => void;
  /** Where focus lands on close: `Cancel order`, or the page's `Status` heading after a change. */
  readonly returnFocusTo: (changed: boolean) => HTMLElement | null;
}

const RACE_SENTENCE =
  'If the order is filled before your cancel confirms, the cancel fails and the fill stands. Only one of them can happen.';

const recoverHref = (order: Order): string => `/recover?txid=${order.funding.txid}`;

/** States after which the order page must refresh and take focus on its `Status` heading. */
const CHANGES_ORDER: readonly CancelFlowState['kind'][] = ['sent', 'race_lost', 'already_spent', 'unknown'];

const LOCKED: readonly CancelFlowState['kind'][] = ['awaiting', 'broadcasting'];

/**
 * Cancel confirmation (cancel-confirmation.md): a Dialog at md+ and a bottom Sheet below. The flow
 * mounts on the first open and gets a fresh key on every open, so each opening starts from `reading`
 * and nothing touches Electrum before the owner asks to cancel.
 */
export function CancelDialog(props: CancelDialogProps) {
  const [session, setSession] = useState(0);
  const [openedFor, setOpenedFor] = useState(false);
  if (props.open !== openedFor) {
    // React's "adjust state when a prop changes": each opening is a new flow session.
    setOpenedFor(props.open);
    if (props.open) setSession((value) => value + 1);
  }

  useEffect(() => {
    if (!props.open) return undefined;
    return getNotificationCenter().openModal('cancel', props.order.id);
  }, [props.open, props.order.id]);

  if (session === 0) return null;
  return <CancelSurface key={session} {...props} />;
}

function CancelSurface({ open, order, wallet, onClosed, returnFocusTo }: CancelDialogProps) {
  const isMdUp = useIsMdUp();
  const network = useNetworkCheck();
  const refundText = (built: BuiltCancel): string =>
    order.side === 'sell' && built.refundTokens > 0n
      ? `${orderInputText({ ...order, amount: built.refundTokens }, 'compact')} and ${bchText(built.refundSats, 'compact')}`
      : bchText(built.refundSats, 'compact');
  const flow = useCancelFlow({
    order,
    ownerPkhHex: open ? (wallet.owner?.ownerPkhHex ?? null) : null,
    refundText,
    onSent: (sent) => finish(sent),
  });
  const { state } = flow;
  const disconnected = wallet.owner === null && PRE_SIGNING.includes(state.kind);
  const locked = LOCKED.includes(state.kind);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const changedRef = useRef(false);

  const titleId = useId();
  const refundLineId = useId();
  const raceId = useId();
  const closeReasonId = useId();
  const keepRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const finish = (final: CancelFlowState): void => {
    const center = getNotificationCenter();
    if (final.kind === 'sent') {
      center.raiseOnClose(cancelSent({ orderId: order.id, txid: final.txid, refundText: final.refundText }));
    } else if (final.kind === 'race_lost') {
      center.raiseOnClose(cancelRaceLost(order));
    } else if (final.kind === 'unknown') {
      const { txid } = final.signed;
      const refund = final.refundText;
      center.raiseOnClose(
        broadcastUnknown({
          flow: { kind: 'cancel', subject: order.id },
          txid,
          checkAgain: () => {
            getChain()
              .getTransactionStatus(txid)
              .then(() =>
                getNotificationCenter().notify(cancelSent({ orderId: order.id, txid, refundText: refund })),
              )
              .catch((error: unknown) => console.warn(`Cancel ${txid} is still not visible:`, error));
          },
        }),
      );
    }
    changedRef.current = CHANGES_ORDER.includes(final.kind);
    onClosed(changedRef.current);
  };

  const close = (): void => {
    if (LOCKED.includes(state.kind)) {
      setCloseBlocked(true);
      return;
    }
    finish(state);
  };

  // Every flow state change moves focus to its status heading, except the first build after opening,
  // where focus stays on `Keep order` (the destructive-dialog pattern).
  const previousKind = useRef<string>(state.kind);
  const firstBuild = useRef(true);
  const shownKind = disconnected ? 'disconnected' : state.kind;
  useEffect(() => {
    if (previousKind.current === shownKind) return;
    const fromInitialRead = previousKind.current === 'reading' && firstBuild.current;
    previousKind.current = shownKind;
    if (fromInitialRead) {
      firstBuild.current = false;
      return;
    }
    firstBuild.current = false;
    headingRef.current?.focus();
  }, [shownKind]);

  const content = (
    <FlowBody
      order={order}
      wallet={wallet}
      flow={flow}
      disconnected={disconnected}
      networkReason={network.status === 'mismatch' ? mismatchReason(network.web, network.api) : null}
      ids={{ titleId, refundLineId, raceId }}
      keepRef={keepRef}
      headingRef={headingRef}
      onClose={close}
    />
  );

  const closeControl = (
    <div className="absolute top-3 right-3 flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close"
        aria-disabled={locked || undefined}
        aria-describedby={locked && closeBlocked ? closeReasonId : undefined}
        onClick={close}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
  const closeReason =
    locked && closeBlocked ? (
      <CloseReason id={closeReasonId} state={state} />
    ) : null;

  const contentProps = {
    role: 'alertdialog' as const,
    'aria-labelledby': titleId,
    'aria-describedby': state.kind === 'review' ? `${refundLineId} ${raceId}` : undefined,
    showClose: false,
    onOpenAutoFocus: (event: Event) => {
      event.preventDefault();
      keepRef.current?.focus();
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      returnFocusTo(changedRef.current)?.focus();
    },
    onEscapeKeyDown: (event: KeyboardEvent) => {
      event.preventDefault();
      close();
    },
    onPointerDownOutside: (event: Event) => {
      event.preventDefault();
      close();
    },
    onInteractOutside: (event: Event) => event.preventDefault(),
  };

  return isMdUp ? (
    <Dialog open={open}>
      <DialogContent {...contentProps} className="max-w-[30rem] gap-5">
        {closeControl}
        <div className="flex flex-col gap-2 pr-12">
          <DialogTitle id={titleId}>Cancel this order?</DialogTitle>
          <DialogDescription className="text-body text-fg-secondary">
            <OrderSummaryLine order={order} />
          </DialogDescription>
        </div>
        {closeReason}
        {content}
      </DialogContent>
    </Dialog>
  ) : (
    <Sheet open={open}>
      <SheetContent {...contentProps} className="gap-5 scroll-pb-40 pb-0">
        {closeControl}
        <div className="flex flex-col gap-2 pr-12">
          <SheetTitle id={titleId}>Cancel this order?</SheetTitle>
          <SheetDescription className="text-body text-fg-secondary">
            <OrderSummaryLine order={order} />
          </SheetDescription>
        </div>
        {closeReason}
        {content}
      </SheetContent>
    </Sheet>
  );
}

function CloseReason({ id, state }: { id: string; state: CancelFlowState }) {
  const since = state.kind === 'broadcasting' ? state.since : null;
  const elapsed = useElapsed(since);
  return (
    <DisabledReason id={id}>
      {state.kind === 'broadcasting'
        ? `Sending · ${formatElapsed(elapsed ?? 0)}. You can close once the network answers or after 20 s.`
        : 'Wait until your wallet answers or cancel the request.'}
    </DisabledReason>
  );
}

function OrderSummaryLine({ order }: { order: Order }) {
  const limit = limitText(order);
  return (
    <span className="num">{limit === null ? sideTitle(order) : `${sideTitle(order)} at ${limit}`}</span>
  );
}

interface FlowBodyProps {
  readonly order: Order;
  readonly wallet: CancelWallet;
  readonly flow: CancelFlow;
  readonly disconnected: boolean;
  readonly networkReason: string | null;
  readonly ids: { readonly titleId: string; readonly refundLineId: string; readonly raceId: string };
  readonly keepRef: RefObject<HTMLButtonElement | null>;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly onClose: () => void;
}

function StatusHeading({
  headingRef,
  children,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>;
  children: string;
}) {
  return (
    <h3 ref={headingRef} tabIndex={-1} className="font-display text-heading-3 text-fg">
      {children}
    </h3>
  );
}

/** Keep order first in the DOM (keyboard order), shown left at md+ and at the bottom edge below md. */
function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-5 flex flex-col-reverse gap-3 border-t border-border bg-surface px-5 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:static md:mx-0 md:flex-row md:justify-end md:border-0 md:p-0 [&>*]:w-full md:[&>*]:w-auto">
      {children}
    </div>
  );
}

function RecoverLink({ order }: { order: Order }) {
  return (
    <Link href={recoverHref(order)} className={buttonVariants({ variant: 'outline' })}>
      Open in Recover
    </Link>
  );
}

function FlowBody({ order, wallet, flow, disconnected, networkReason, ids, keepRef, headingRef, onClose }: FlowBodyProps) {
  const { state } = flow;
  const host = getChain().endpointLabel ?? 'your Electrum server';
  const keep = (
    <Button ref={keepRef} variant="outline" onClick={onClose}>
      Keep order
    </Button>
  );
  const closeButton = (
    <Button ref={keepRef} variant="outline" onClick={onClose}>
      Close
    </Button>
  );

  if (disconnected) {
    return (
      <>
        <section className="flex flex-col gap-3">
          <StatusHeading headingRef={headingRef}>Wallet disconnected</StatusHeading>
          <p className="text-body text-fg-secondary">Your wallet disconnected. Reconnect to cancel.</p>
        </section>
        <Footer>
          {keep}
          <ConnectWalletButton fallback={() => headingRef.current} />
        </Footer>
      </>
    );
  }

  switch (state.kind) {
    case 'reading':
      return (
        <>
          <section aria-busy="true" className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Reading the order</StatusHeading>
            <p className="text-body-sm text-fg-muted">{`Reading the order and your coins from ${host}`}</p>
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </section>
          <SignFooter keep={keep} reason="Building the cancel." onSign={flow.sign} />
        </>
      );
    case 'review':
      return (
        <ReviewBody
          order={order}
          wallet={wallet}
          flow={flow}
          state={state}
          ids={ids}
          headingRef={headingRef}
          keep={keep}
          networkReason={networkReason}
        />
      );
    case 'no_coin':
      return (
        <NoCoinBody order={order} wallet={wallet} flow={flow} state={state} headingRef={headingRef} keep={keep} />
      );
    case 'already_spent': {
      const word =
        state.spend?.path === 'execute' ? 'filled' : state.spend?.path === 'cancel' ? 'cancelled' : null;
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>
              {word === null ? 'Order already spent' : `Order already ${word}`}
            </StatusHeading>
            {state.spend === null ? (
              <p className="text-body text-fg-secondary">
                The order’s output is already spent. There is nothing left to cancel.
              </p>
            ) : (
              <>
                <p className="text-body text-fg-secondary">
                  {word === null
                    ? 'This order was already spent by a transaction that is neither a fill nor a cancel. There is nothing left to cancel.'
                    : `This order was already ${word} in transaction ${state.spend.txid.slice(0, 8)}…${state.spend.txid.slice(-6)}. There is nothing left to cancel.`}
                </p>
                <HashChip value={state.spend.txid} kind="tx" />
              </>
            )}
          </section>
          <Footer>{closeButton}</Footer>
        </>
      );
    }
    case 'awaiting':
      return <AwaitingBody since={state.since} wallet={wallet} flow={flow} headingRef={headingRef} />;
    case 'rejected':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Cancel declined</StatusHeading>
            <p className="text-body text-fg-secondary">
              You declined the cancel in your wallet. Your order is still open.
            </p>
          </section>
          <Footer>
            {keep}
            <Button variant="destructive" onClick={flow.retry}>
              Try again
            </Button>
          </Footer>
        </>
      );
    case 'signing_error':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Transaction not sent</StatusHeading>
            <InlineAlert tone="error" role="alert">
              <p>
                <span className="hash text-mono-sm text-fg">WALLET_SESSION_ENDED</span>
                {`: your wallet disconnected before answering (${state.reason}). Your order is still open.`}
              </p>
            </InlineAlert>
          </section>
          <Footer>
            {closeButton}
            <Button variant="destructive" onClick={flow.retry}>
              Try again
            </Button>
          </Footer>
        </>
      );
    case 'changed':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Signed cancel changed</StatusHeading>
            <InlineAlert tone="error" role="alert">
              <p>{`Your wallet returned a cancel that differs from the one shown (${state.rule}). AtPrice did not broadcast it.`}</p>
              <p className="hash text-mono-sm text-fg">Code: SIGNED_TX_MISMATCH</p>
            </InlineAlert>
          </section>
          <Footer>
            {closeButton}
            <RecoverLink order={order} />
          </Footer>
        </>
      );
    case 'broadcasting':
      return <BroadcastingBody state={state} host={host} headingRef={headingRef} />;
    case 'unknown':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Broadcast not confirmed</StatusHeading>
            <InlineAlert tone="warning">
              <p>{`AtPrice couldn’t confirm the broadcast. Cancel ${state.signed.txid.slice(0, 8)}…${state.signed.txid.slice(-6)} may or may not have reached the network.`}</p>
              {state.lookupCode === null ? null : (
                <p>
                  Couldn’t look it up: <span className="hash text-mono-sm text-fg">{state.lookupCode}</span>
                </p>
              )}
              {state.lookedUp ? <p>{`${host} doesn’t know this transaction.`}</p> : null}
            </InlineAlert>
            <HashChip value={state.signed.txid} kind="tx" />
          </section>
          <Footer>
            {closeButton}
            <RecoverLink order={order} />
            {state.lookedUp ? (
              <Button variant="outline" onClick={flow.broadcastAgain}>
                Broadcast again
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={flow.checkBroadcastAgain}
              aria-disabled={state.checking || undefined}
            >
              {state.checking ? 'Checking' : 'Check again'}
            </Button>
          </Footer>
        </>
      );
    case 'sent':
      return (
        <section className="flex flex-col gap-3">
          <StatusHeading headingRef={headingRef}>Cancel sent</StatusHeading>
          <HashChip value={state.txid} kind="tx" />
        </section>
      );
    case 'race_lost':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Cancel failed</StatusHeading>
            <InlineAlert tone="error" role="alert">
              <p>{`The order was filled before your cancel reached the network (transaction ${state.spend.txid.slice(0, 8)}…${state.spend.txid.slice(-6)}). The fill stands and the cancel was not applied. You received ${receivedText(order, state.spend.delivered, 'exact')}.`}</p>
            </InlineAlert>
            <HashChip value={state.spend.txid} kind="tx" />
          </section>
          <Footer>
            {closeButton}
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                window.location.hash = 'receipt';
              }}
            >
              View receipt
            </Button>
          </Footer>
        </>
      );
    case 'rejected_other':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Cancel rejected</StatusHeading>
            <InlineAlert tone="error" role="alert">
              <p>{`The network rejected the cancel: ${state.message}. Your order is still open.`}</p>
            </InlineAlert>
          </section>
          <Footer>
            {closeButton}
            <Button variant="destructive" onClick={flow.retry}>
              Try again
            </Button>
          </Footer>
        </>
      );
    case 'chain_error':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Couldn’t read the order</StatusHeading>
            <InlineAlert tone="error" role="alert">
              <p>
                {`Couldn’t read the order from ${state.host ?? host} (`}
                <span className="hash text-mono-sm text-fg">{state.code}</span>
                {'). Your order is unchanged.'}
              </p>
            </InlineAlert>
          </section>
          <Footer>
            {keep}
            <RecoverLink order={order} />
            <Button variant="primary" onClick={flow.retry}>
              Retry
            </Button>
          </Footer>
        </>
      );
    case 'build_invalid':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Safety check failed</StatusHeading>
            <InlineAlert tone="error" role="alert">
              <p>{`The cancel built in your browser failed a safety check (${state.rule}). Nothing was sent to your wallet.`}</p>
              <p className="hash text-mono-sm text-fg">Code: CANCEL_BUILD_INVALID</p>
            </InlineAlert>
          </section>
          <Footer>
            {keep}
            <RecoverLink order={order} />
          </Footer>
        </>
      );
    case 'derivation_mismatch':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Record doesn’t match</StatusHeading>
            <InlineAlert tone="error" role="alert">
              <p>The order record on chain doesn’t rebuild this contract.</p>
              <p className="hash text-mono-sm text-fg">Code: RECOVER_DERIVATION_MISMATCH</p>
            </InlineAlert>
          </section>
          <Footer>
            {keep}
            <RecoverLink order={order} />
          </Footer>
        </>
      );
    case 'not_owner':
      return (
        <>
          <section className="flex flex-col gap-3">
            <StatusHeading headingRef={headingRef}>Different wallet</StatusHeading>
            <p className="text-body text-fg-secondary">
              This order belongs to a different wallet. Only the wallet that created it can cancel it.
            </p>
          </section>
          <Footer>{closeButton}</Footer>
        </>
      );
  }
}

function SignFooter({
  keep,
  reason,
  onSign,
  extra,
}: {
  keep: ReactNode;
  reason: string | null;
  onSign: () => void;
  extra?: ReactNode | undefined;
}) {
  const reasonId = useId();
  return (
    <div className="flex flex-col gap-2">
      {extra}
      <Footer>
        {keep}
        <Button
          variant="destructive"
          onClick={onSign}
          aria-disabled={reason !== null || undefined}
          aria-describedby={reason === null ? undefined : reasonId}
        >
          Sign cancel in wallet
        </Button>
      </Footer>
      {reason === null ? null : (
        <DisabledReason id={reasonId} className="md:text-right">
          {reason}
        </DisabledReason>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-start gap-3">
      <dt className="text-body-sm text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-body-sm text-fg">{children}</dd>
    </div>
  );
}

function ReviewBody({
  order,
  wallet,
  flow,
  state,
  ids,
  headingRef,
  keep,
  networkReason,
}: {
  order: Order;
  wallet: CancelWallet;
  flow: CancelFlow;
  state: Extract<CancelFlowState, { kind: 'review' }>;
  ids: FlowBodyProps['ids'];
  headingRef: FlowBodyProps['headingRef'];
  keep: ReactNode;
  networkReason: string | null;
}) {
  const { built } = state;
  const owner = wallet.owner;
  const elapsed = useElapsed(wallet.reconnectingSince);
  const address = owner === null ? null : order.side === 'sell' ? owner.tokenAddress : owner.address;
  const signatureWallet = placeholderSigningWallet(wallet.walletName);
  const server = serverCheckText(state.server);
  const reason =
    networkReason ??
    (wallet.reconnectingSince === null
      ? null
      : `Reconnecting to your wallet (${formatElapsed(elapsed ?? 0)}). Requests resume when it answers.`);
  const refundSpoken = [
    order.side === 'sell' && built.refundTokens > 0n
      ? orderInputText({ ...order, amount: built.refundTokens }, 'exact')
      : null,
    bchText(built.refundSats, 'exact'),
  ]
    .filter((part) => part !== null)
    .join(' and ');

  return (
    <>
      <section className="flex flex-col gap-4">
        <StatusHeading headingRef={headingRef}>Ready to cancel</StatusHeading>
        <HashChip value={order.funding.txid} kind="tx" label={`Order ${order.funding.txid}`} />
        <div className="flex flex-col gap-1">
          <p id={ids.refundLineId} className="sr-only">
            {`You get back ${refundSpoken}${address === null ? '' : ` to ${address}`}`}
          </p>
          <p aria-hidden="true" className="text-label text-fg-muted">
            You get back
          </p>
          <div aria-hidden="true" className="flex flex-col">
            {order.side === 'sell' && built.refundTokens > 0n ? (
              <Num size="lg">{orderInputText({ ...order, amount: built.refundTokens }, 'exact')}</Num>
            ) : null}
            <Num size="lg">{bchText(built.refundSats, 'exact')}</Num>
          </div>
        </div>
        <dl className="flex flex-col gap-3">
          <Row label="To">
            {address === null ? (
              <span className="text-fg-muted">Your owner address</span>
            ) : (
              <HashChip value={address} kind="address" label={`Refund address ${address}`} />
            )}
          </Row>
          <Row label="Network fee">
            <Num>{formatFee(built.fee)}</Num>, taken from the refund
          </Row>
          <Row label="Authorized by">
            {built.path === 'cancel' && built.ownerCoin !== null ? (
              <span className="flex flex-col gap-2">
                <span>A coin at your owner address</span>
                <span className="text-fg-secondary">
                  <Num>{`${formatBch(built.ownerCoin.satoshis, 'exact')} BCH`}</Num> from{' '}
                  {owner === null ? 'your owner address' : (
                    <HashChip value={owner.address} kind="address" label={`Owner address ${owner.address}`} />
                  )}{' '}
                  goes back to the same address in the same transaction.
                </span>
              </span>
            ) : (
              `Your wallet’s signature inside the contract (${signatureWallet ?? wallet.walletName ?? 'your wallet'} supports this)`
            )}
          </Row>
        </dl>
        {server === null ? null : (
          <InlineAlert tone={state.server.kind === 'different' ? 'warning' : 'info'}>
            <p>{server}</p>
          </InlineAlert>
        )}
        <p id={ids.raceId} className="text-body-sm text-fg-secondary">
          {RACE_SENTENCE}
        </p>
      </section>
      <SignFooter
        keep={keep}
        reason={reason}
        onSign={flow.sign}
        extra={networkReason === null ? null : <RecoverLink order={order} />}
      />
    </>
  );
}

function NoCoinBody({
  order,
  wallet,
  flow,
  state,
  headingRef,
  keep,
}: {
  order: Order;
  wallet: CancelWallet;
  flow: CancelFlow;
  state: Extract<CancelFlowState, { kind: 'no_coin' }>;
  headingRef: FlowBodyProps['headingRef'];
  keep: ReactNode;
}) {
  const elapsed = useElapsed(state.since);
  const owner = wallet.owner;
  const request = topUpRequest(state.requiredSatoshis);
  const signatureWallet = placeholderSigningWallet(wallet.walletName);
  const ownerLocking = flow.onChain?.ownerLocking ?? null;

  // Electrum is the external system: a payment to the owner address changes its status, and the
  // cancel is rebuilt from the new coins. The first notification is the current status, so skip it.
  const onStatus = useEffectEvent(() => flow.checkCoinAgain());
  useEffect(() => {
    if (ownerLocking === null) return undefined;
    let first = true;
    let unsubscribe: (() => Promise<void>) | null = null;
    let active = true;
    getChain()
      .subscribeAddress(ownerLocking, () => {
        if (first) {
          first = false;
          return;
        }
        if (active) onStatus();
      })
      .then((stop) => {
        if (active) unsubscribe = stop;
        else void stop();
      })
      .catch((error: unknown) => console.warn('Owner address subscription failed; Check again still works:', error));
    return () => {
      active = false;
      if (unsubscribe !== null) void unsubscribe();
    };
  }, [ownerLocking]);

  return (
    <>
      <section className="flex flex-col gap-4">
        <StatusHeading headingRef={headingRef}>Your wallet needs a coin first</StatusHeading>
        <p className="text-body text-fg-secondary">
          Your wallet needs a coin at this order’s owner address before it can cancel. Send at least{' '}
          <Num>{formatFee(request)}</Num> to {owner === null ? 'your owner address' : 'the address below'} from
          any wallet. AtPrice will notice the payment and continue.
        </p>
        {owner === null ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <HashChip value={owner.address} kind="address" label={`Owner address ${owner.address}`} />
            <Popover>
              <PopoverTrigger className={cn(buttonVariants({ variant: 'outline', size: 'compact' }))}>
                <QrCodeIcon aria-hidden="true" />
                Show QR
              </PopoverTrigger>
              <PopoverContent>
                <QrCode value={owner.address} size={200} label={`QR code of your owner address ${owner.address}`} />
              </PopoverContent>
            </Popover>
          </div>
        )}
        <p className="text-body-sm text-fg-muted">
          Waiting · <span className="num">{formatElapsed(elapsed ?? 0)}</span>
        </p>
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap">
          <Button variant="outline" onClick={flow.checkCoinAgain} aria-disabled={state.checking || undefined}>
            {state.checking ? 'Checking' : 'Check again'}
          </Button>
          {signatureWallet === null ? null : (
            <Button variant="outline" onClick={flow.signInsideContract}>
              {`Sign inside the contract with ${signatureWallet}`}
            </Button>
          )}
        </div>
        <p className="sr-only">{`Order ${order.funding.txid}`}</p>
      </section>
      <Footer>{keep}</Footer>
    </>
  );
}

function AwaitingBody({
  since,
  wallet,
  flow,
  headingRef,
}: {
  since: number;
  wallet: CancelWallet;
  flow: CancelFlow;
  headingRef: FlowBodyProps['headingRef'];
}) {
  const elapsed = useElapsed(since);
  const reconnecting = useElapsed(wallet.reconnectingSince);
  return (
    <>
      <section className="flex flex-col gap-3">
        <StatusHeading headingRef={headingRef}>Waiting for your wallet</StatusHeading>
        <p className="text-body text-fg-secondary">
          {wallet.reconnectingSince === null ? (
            <>
              Approve the cancel in your wallet · <span className="num">{formatElapsed(elapsed ?? 0)}</span>. AtPrice
              waits as long as your wallet takes.
            </>
          ) : (
            <>
              Reconnecting to your wallet (<span className="num">{formatElapsed(reconnecting ?? 0)}</span>). Your
              request is sent again when it answers.
            </>
          )}
        </p>
      </section>
      <Footer>
        <Button variant="outline" onClick={flow.cancelRequest}>
          Cancel request
        </Button>
      </Footer>
    </>
  );
}

function BroadcastingBody({
  state,
  host,
  headingRef,
}: {
  state: Extract<CancelFlowState, { kind: 'broadcasting' }>;
  host: string;
  headingRef: FlowBodyProps['headingRef'];
}) {
  const elapsed = useElapsed(state.since);
  return (
    <section aria-busy="true" className="flex flex-col gap-3 pb-5 md:pb-0">
      <StatusHeading headingRef={headingRef}>Sending</StatusHeading>
      <p className="text-body text-fg-secondary">
        {`Sending to the network through ${host} · `}
        <span className="num">{formatElapsed(elapsed ?? 0)}</span>.
      </p>
      <HashChip value={state.signed.txid} kind="tx" label={`Cancel transaction ${state.signed.txid}`} />
    </section>
  );
}
