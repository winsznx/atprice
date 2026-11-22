'use client';

import { BUY_PAYOUT_SATS, FUNDING_MARKER_SATS, SELL_ORDER_SATS, type FundingDraft } from '@atprice/core';
import { InfoIcon, ShieldCheckIcon, XIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { BchAmount, Num, TokenAmount } from '@/components/amount';
import { FeeDisclosure, type FeeDisclosureValues } from '@/components/fee-disclosure';
import { HashChip, useCopy } from '@/components/hash-chip';
import { DisabledReason, ErrorState, FUNDS_STILL_SAFE, InlineAlert } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ConnectWalletButton } from '@/components/wallet/wallet-button';
import { formatBch, formatElapsed, formatToken } from '@/lib/format';
import { useIsMdUp } from '@/lib/hooks/use-media-query';
import { useElapsed } from '@/lib/hooks/use-now';
import { appNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { typedLimitText } from '../trade/order-summary';
import { limitUnit } from '../trade/terms';
import { RiskList } from '../trade/risk-list';
import { estimateCancelFee, offlineProvider } from './fees';
import { closeBlockedReason, phaseOrderState, phaseTxid, type FundingPhase, type UpdatedRow } from './flow';
import { RecordView } from './record-view';
import type { FundingSession } from './session';

/** The wallet as the dialog needs it; `disconnected` covers every state that can't sign. */
export type DialogWallet =
  | { readonly kind: 'connected' }
  | { readonly kind: 'reconnecting'; readonly since: number }
  | { readonly kind: 'disconnected' };

/** Phases before anything was signed: a dropped wallet replaces their button row (funding-confirmation.md). */
const PRE_SIGN: ReadonlySet<FundingPhase['kind']> = new Set([
  'building',
  'review',
  'utxo_error',
  'build_error',
  'rejected',
  'signing_error',
]);

export const statusHeading = (phase: FundingPhase, disconnected: boolean): string => {
  if (disconnected && PRE_SIGN.has(phase.kind)) return 'Wallet disconnected';
  switch (phase.kind) {
    case 'building':
      return 'Building the transaction';
    case 'utxo_error':
      return 'Couldn’t read your coins';
    case 'build_error':
      return 'Transaction can’t be built';
    case 'review':
      return phase.coinsChanged ? 'Coins changed' : 'Review your order';
    case 'awaiting_signature':
      return 'Waiting for your wallet';
    case 'rejected':
      return 'Transaction declined';
    case 'signing_error':
      return 'Transaction not sent';
    case 'signed_changed':
      return 'Signed transaction changed';
    case 'draft_changed':
      return 'Order terms changed';
    case 'broadcasting':
      return 'Sending';
    case 'broadcast_unknown':
      return 'Broadcast not confirmed';
    case 'broadcast_rejected':
      return 'Funding failed';
    case 'registering':
    case 'registered':
      return 'Funding sent';
    case 'register_failed':
      return 'Order not registered yet';
  }
};

const draftOf = (phase: FundingPhase): FundingDraft | null => {
  switch (phase.kind) {
    case 'review':
      return phase.draft;
    case 'awaiting_signature':
    case 'rejected':
    case 'signing_error':
      return phase.draft;
    default:
      return null;
  }
};

/** Disabled reason of `Confirm and sign in wallet`, in the order the spec lists its conditions. */
export const confirmReason = (
  phase: FundingPhase,
  wallet: DialogWallet,
  networkMismatch: string | null,
  elapsedText: string,
): string | null => {
  if (phase.kind === 'building') return 'Building the funding transaction.';
  if (phase.kind === 'utxo_error') return 'The funding transaction can’t be built until your coins are read.';
  if (phase.kind !== 'review') return null;
  if (networkMismatch !== null) return networkMismatch;
  if (wallet.kind === 'reconnecting') {
    return `Reconnecting to your wallet (${elapsedText}). Requests resume when it answers.`;
  }
  if (phase.shortfall !== null) {
    return `Your balance changed and no longer covers this order (${formatBch(phase.shortfall.needed, 'exact')} BCH needed, ${formatBch(phase.shortfall.available, 'exact')} BCH available).`;
  }
  if (phase.draft === null) return 'Building the funding transaction.';
  return null;
};

function Updated({ show }: { show: boolean }) {
  return show ? (
    <span className="ml-2 rounded-xs bg-status-pending-subtle px-1 text-caption text-status-pending">
      Updated
    </span>
  ) : null;
}

function Row({
  label,
  children,
  updated = false,
}: {
  label: string;
  children: ReactNode;
  updated?: boolean | undefined;
}) {
  return (
    <div className="flex flex-col gap-1 py-3 md:flex-row md:justify-between md:gap-4">
      <dt className="shrink-0 text-label text-fg-secondary">
        {label}
        <Updated show={updated} />
      </dt>
      <dd className="min-w-0 text-body-sm text-fg md:text-right">{children}</dd>
    </div>
  );
}

export function FundingDialog({
  session,
  open,
  wallet,
  networkMismatch,
  versusLine,
  onClose,
  titleRef,
  statusRef,
}: {
  session: FundingSession;
  open: boolean;
  wallet: DialogWallet;
  networkMismatch: string | null;
  /** The fresh `Versus your limit` line from the ticket's quote ("Quote moved" is not a blocker). */
  versusLine: string | null;
  onClose: () => void;
  titleRef: Ref<HTMLHeadingElement>;
  statusRef: Ref<HTMLHeadingElement>;
}) {
  const phase = useSyncExternalStore(session.flow.subscribe, session.flow.getPhase, session.flow.getPhase);
  const isMdUp = useIsMdUp();
  const lockId = useId();
  const since =
    phase.kind === 'awaiting_signature' || phase.kind === 'broadcasting'
      ? phase.since
      : wallet.kind === 'reconnecting'
        ? wallet.since
        : null;
  const elapsed = useElapsed(since);
  const elapsedText = elapsed === null ? '0:00' : formatElapsed(elapsed);
  const blocked = closeBlockedReason(phase, elapsedText);
  const disconnected = wallet.kind === 'disconnected' && PRE_SIGN.has(phase.kind);
  const heading = statusHeading(phase, disconnected);

  // Each new flow state moves focus to its status heading, which is announced once (not a live region).
  const shownHeading = useRef(heading);
  useEffect(() => {
    if (shownHeading.current === heading) return;
    shownHeading.current = heading;
    focusRef(statusRef);
  }, [heading, statusRef]);

  const preventWhenBlocked = (event: Event) => {
    if (blocked !== null) event.preventDefault();
  };
  const onOpenChange = (next: boolean) => {
    if (!next && blocked === null) onClose();
  };

  const header = (
    <div className="flex flex-col gap-1 pr-12">
      {isMdUp ? (
        <DialogTitle ref={titleRef} tabIndex={-1}>
          Review and fund your order
        </DialogTitle>
      ) : (
        <SheetTitle ref={titleRef} tabIndex={-1}>
          Review and fund your order
        </SheetTitle>
      )}
      {isMdUp ? (
        <DialogDescription>{subtitle(session)}</DialogDescription>
      ) : (
        <SheetDescription>{subtitle(session)}</SheetDescription>
      )}
    </div>
  );

  const body = (
    <>
      <CloseButton blocked={blocked} onClose={onClose} />
      {header}
      <Summary session={session} phase={phase} lockId={lockId} versusLine={versusLine} />
      <RiskList title="What you are signing" headingId="before-you-sign" headingLevel="h3" />
      <section aria-live="off" className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 ref={statusRef} tabIndex={-1} className="font-display text-heading-3 text-fg">
            {heading}
          </h3>
          {phaseOrderState(phase) === null ? null : (
            <StatusBadge status={phaseOrderState(phase) ?? 'FUNDING_PENDING'} />
          )}
        </div>
        <PhaseBody
          session={session}
          phase={phase}
          wallet={wallet}
          disconnected={disconnected}
          networkMismatch={networkMismatch}
          elapsedText={elapsedText}
          onClose={onClose}
          statusRef={statusRef}
        />
      </section>
    </>
  );

  if (isMdUp) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showClose={false}
          aria-describedby={lockId}
          onEscapeKeyDown={preventWhenBlocked}
          onPointerDownOutside={preventWhenBlocked}
          onInteractOutside={preventWhenBlocked}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusRef(titleRef);
          }}
          className="max-h-[90vh] max-w-[35rem] gap-5"
        >
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showClose={false}
        aria-describedby={lockId}
        onEscapeKeyDown={preventWhenBlocked}
        onPointerDownOutside={preventWhenBlocked}
        onInteractOutside={preventWhenBlocked}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusRef(titleRef);
        }}
        className="h-dvh max-h-dvh gap-5 rounded-none [scroll-padding-bottom:9rem]"
      >
        {body}
      </SheetContent>
    </Sheet>
  );
}

const focusRef = (ref: Ref<HTMLHeadingElement>): void => {
  if (ref !== null && typeof ref === 'object') ref.current?.focus();
};

const subtitle = (session: FundingSession): string =>
  `${session.order.params.side === 'buy' ? 'Buy' : 'Sell'} ${session.market.symbol} on BCH/${session.market.symbol}`;

function CloseButton({ blocked, onClose }: { blocked: string | null; onClose: () => void }) {
  const reasonId = useId();
  return (
    <div className="absolute top-3 right-3 flex max-w-[14rem] flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close"
        aria-disabled={blocked !== null || undefined}
        aria-describedby={blocked === null ? undefined : reasonId}
        onClick={onClose}
      >
        <XIcon aria-hidden="true" />
      </Button>
      {blocked === null ? null : (
        <DisabledReason id={reasonId} className="text-right">
          {blocked}
        </DisabledReason>
      )}
    </div>
  );
}

function Summary({
  session,
  phase,
  lockId,
  versusLine,
}: {
  session: FundingSession;
  phase: FundingPhase;
  lockId: string;
  versusLine: string | null;
}) {
  const { order, market } = session;
  const side = order.params.side;
  const funding =
    side === 'buy' ? order.amount + order.params.maxNetworkFee + BUY_PAYOUT_SATS : SELL_ORDER_SATS;
  const draft = draftOf(phase);
  const updated: readonly UpdatedRow[] = phase.kind === 'review' ? phase.updated : [];
  const cancelFee = useMemo(
    () =>
      draft === null
        ? null
        : estimateCancelFee(order.params, draft, session.feePerByte, offlineProvider(appNetwork.network)),
    [draft, order.params, session.feePerByte],
  );
  const lockText =
    side === 'buy'
      ? `${formatBch(funding, 'exact')} BCH`
      : `${formatToken(order.amount, market.decimals, 'exact')} ${market.symbol} and ${formatBch(SELL_ORDER_SATS, 'exact')} BCH reserve`;

  const fees: FeeDisclosureValues | null =
    draft === null || cancelFee === null
      ? null
      : {
          side,
          protocolFeeBps: session.protocolFeeBps,
          fundingFee: {
            basis: 'exact',
            sats: draft.fee,
            bytes: draft.estimatedSize,
            satsPerByte: session.feePerByte,
          },
          maxNetworkFee: order.params.maxNetworkFee,
          cancelFeeEstimate: cancelFee,
          tokenDust: side === 'buy' ? BUY_PAYOUT_SATS : null,
          keptForCancel: {
            kind: draft.ownerOutputSatoshis === FUNDING_MARKER_SATS ? 'marker' : 'change',
            sats: draft.ownerOutputSatoshis,
          },
        };

  return (
    <div className="flex flex-col gap-5">
      <dl className="flex flex-col divide-y divide-border">
        <div className="flex flex-col gap-1 pb-3">
          <dt className="text-label text-fg-secondary">You lock</dt>
          <dd id={lockId} className="flex flex-col gap-1">
            <span className="sr-only">{`You lock ${lockText}.`}</span>
            <span aria-hidden="true" className="num text-num-lg text-fg">
              {lockText}
            </span>
            {side === 'buy' ? (
              <Num className="text-body-sm text-fg-secondary">
                {`${formatBch(order.amount, 'exact')} BCH order + ${formatBch(order.params.maxNetworkFee, 'exact')} BCH network fee cap + ${formatBch(BUY_PAYOUT_SATS, 'exact')} BCH token dust`}
              </Num>
            ) : null}
          </dd>
        </div>
        <Row label="Kept in your wallet" updated={updated.includes('kept')}>
          {draft === null ? (
            <Skeleton className="ml-auto h-5 w-48" />
          ) : (
            <span className="flex flex-col gap-1 md:items-end">
              <Num>
                {draft.ownerOutputSatoshis === FUNDING_MARKER_SATS
                  ? `${formatBch(draft.ownerOutputSatoshis, 'exact')} BCH cancel marker`
                  : `${formatBch(draft.ownerOutputSatoshis, 'exact')} BCH change`}
              </Num>
              <span className="text-caption text-fg-muted">at your owner address</span>
              <HashChip
                value={session.ownerAddress}
                kind="address"
                label={`Owner address ${session.ownerAddress}`}
              />
              <span className="text-caption text-fg-muted">
                Stays in your wallet. A cancel later uses it to prove you own the order.
              </span>
            </span>
          )}
        </Row>
        <Row label="Leaves your wallet" updated={updated.includes('leaves')}>
          {draft === null ? (
            <Skeleton className="ml-auto h-5 w-40" />
          ) : (
            <span className="flex flex-col gap-1 md:items-end">
              <Num>
                {side === 'buy'
                  ? `${formatBch(funding + draft.fee, 'exact')} BCH`
                  : `${formatToken(order.amount, market.decimals, 'exact')} ${market.symbol} and ${formatBch(funding + draft.fee, 'exact')} BCH`}
              </Num>
              <Num className="text-caption text-fg-muted">{`what you lock + ${formatBch(draft.fee, 'exact')} BCH funding fee`}</Num>
            </span>
          )}
        </Row>
        <Row label="You receive at least">
          <span className="flex flex-col gap-1 md:items-end">
            {side === 'buy' ? (
              <TokenAmount
                units={session.minProceeds}
                decimals={market.decimals}
                symbol={market.symbol}
                mode="exact"
              />
            ) : (
              <>
                <BchAmount sats={session.minProceeds} mode="exact" />
                <Num className="text-caption text-fg-muted">
                  {`Paid in one output of at least ${formatBch(session.minProceeds + SELL_ORDER_SATS, 'exact')} BCH: your proceeds plus the 2,000 sat reserve you locked. The network fee comes out of the pool’s BCH, not out of this.`}
                </Num>
              </>
            )}
            {versusLine === null ? null : <span className="text-caption text-fg-muted">{versusLine}</span>}
          </span>
        </Row>
        <Row label="Limit price">
          <Num>{`${typedLimitText(session.limit.text)} ${limitUnit(session.limit.orientation, market.symbol)}`}</Num>
        </Row>
        <Row label="Paid to">
          <span className="flex flex-col gap-1 md:items-end">
            <HashChip
              value={session.recipientAddress}
              kind="address"
              label={`Paid to ${session.recipientAddress}`}
            />
            {session.recipientIsWallet ? (
              <span className="text-caption text-fg-muted">your wallet</span>
            ) : null}
          </span>
        </Row>
        <Row label="Contract address">
          <HashChip
            value={order.orderAddress}
            kind="address"
            label={`Contract address ${order.orderAddress}`}
          />
        </Row>
      </dl>
      {session.verification === 'matched' ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md bg-status-filled-subtle p-3 text-body-sm text-fg"
        >
          <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-status-filled" />
          Built in your browser. AtPrice’s server derived the same contract address.
        </p>
      ) : (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-body-sm text-fg"
        >
          <InfoIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fg-secondary" />
          <span>
            Built in your browser. AtPrice’s server didn’t pre-check this order (
            <span className="hash text-mono-sm">INTENT_LIMIT_REACHED</span>). It registers after funding.
          </span>
        </p>
      )}
      {fees === null ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <p className="text-label font-semibold text-fg">Fees</p>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </div>
      ) : (
        <div
          className={cn(
            updated.includes('funding_fee') && 'rounded-md ring-1 ring-status-pending ring-offset-4',
          )}
        >
          {updated.includes('funding_fee') ? <Updated show /> : null}
          <FeeDisclosure values={fees} variant="confirmation" />
        </div>
      )}
      <section aria-labelledby="how-to-cancel" className="flex flex-col gap-1">
        <h3 id="how-to-cancel" className="text-label font-semibold text-fg">
          How to cancel
        </h3>
        <p className="text-body-sm text-fg-secondary">
          Any time, from My orders, or from Recover without AtPrice’s server. Only this wallet can cancel.
        </p>
      </section>
      <RecordView record={order.record} />
    </div>
  );
}

function PhaseBody({
  session,
  phase,
  wallet,
  disconnected,
  networkMismatch,
  elapsedText,
  onClose,
  statusRef,
}: {
  session: FundingSession;
  phase: FundingPhase;
  wallet: DialogWallet;
  disconnected: boolean;
  networkMismatch: string | null;
  elapsedText: string;
  onClose: () => void;
  statusRef: Ref<HTMLHeadingElement>;
}) {
  const flow = session.flow;
  const txid = phaseTxid(phase);
  const txChip =
    txid === null ? null : <HashChip value={txid} kind="tx" label={`Funding transaction ${txid}`} />;
  const back = (
    <Button variant="outline" onClick={onClose}>
      Back
    </Button>
  );
  const tryAgain = (
    <Button variant="primary" onClick={() => void flow.tryAgain()}>
      Try again
    </Button>
  );

  if (disconnected) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-body-sm text-fg-secondary">
          Your wallet disconnected. Reconnect to continue. Your order terms are kept.
        </p>
        <Footer>
          {back}
          <ConnectWalletButton
            fallback={() => (statusRef !== null && typeof statusRef === 'object' ? statusRef.current : null)}
          />
        </Footer>
      </div>
    );
  }

  switch (phase.kind) {
    case 'building':
    case 'review':
    case 'utxo_error': {
      const reason = confirmReason(phase, wallet, networkMismatch, elapsedText);
      return (
        <div className="flex flex-col gap-3">
          {phase.kind === 'utxo_error' ? (
            <ErrorState
              what={`Couldn’t read your wallet’s coins from ${phase.host ?? 'the Electrum server'} (${phase.code}).`}
              code={phase.code}
              onRetry={() => void flow.build()}
            />
          ) : null}
          {phase.kind === 'review' && phase.coinsChanged ? (
            <InlineAlert tone="warning">
              Your wallet’s coins changed, so the transaction was rebuilt. Check the figures again.
            </InlineAlert>
          ) : null}
          {phase.kind === 'review' && phase.stoppedWaiting ? (
            <InlineAlert tone="info">
              Stopped waiting. If your wallet still shows the request, decline it there. AtPrice asked your
              wallet not to broadcast, so nothing reaches the network unless AtPrice sends it.
            </InlineAlert>
          ) : null}
          <ConfirmRow back={back} reason={reason} onConfirm={() => void flow.confirm()} />
        </div>
      );
    }
    case 'build_error':
      return (
        <div className="flex flex-col gap-3">
          <ErrorState
            what={`The funding transaction can’t be built: ${phase.message}. Nothing was sent to your wallet.`}
            code={phase.code}
          />
          <Footer>{back}</Footer>
        </div>
      );
    case 'awaiting_signature':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg-secondary">
            Approve the transaction in your wallet ·{' '}
            <span className="num" aria-hidden="true">
              {elapsedText}
            </span>
            . Nothing is sent until you approve, and AtPrice broadcasts it only after you do. AtPrice waits as
            long as your wallet takes.
          </p>
          {wallet.kind === 'reconnecting' ? (
            <p className="text-body-sm text-status-pending">
              Reconnecting to your wallet (<span className="num">{elapsedText}</span>). Your request is sent
              again when it answers.
            </p>
          ) : null}
          <Footer>
            <Button variant="outline" onClick={() => flow.cancelRequest()}>
              Cancel request
            </Button>
          </Footer>
        </div>
      );
    case 'rejected':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg">
            You declined the transaction in your wallet. No order was created and nothing left your wallet.
          </p>
          <Footer>
            {back}
            {tryAgain}
          </Footer>
        </div>
      );
    case 'signing_error':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg">
            <span className="hash text-mono-sm">{phase.code}</span>: your wallet disconnected before answering
            ({phase.reason}). Nothing was sent.
          </p>
          <Footer>
            {back}
            {tryAgain}
          </Footer>
        </div>
      );
    case 'signed_changed':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg">
            Your wallet returned a transaction that differs from the one shown ({phase.difference}). AtPrice
            did not broadcast it. Code: <span className="hash text-mono-sm">SIGNED_TX_MISMATCH</span>.
          </p>
          <Footer>{back}</Footer>
        </div>
      );
    case 'draft_changed':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg">
            The order terms changed after review. Nothing was sent to your wallet. Code:{' '}
            <span className="hash text-mono-sm">DRAFT_CHANGED</span>.
          </p>
          <Footer>{back}</Footer>
        </div>
      );
    case 'broadcasting':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg-secondary">
            Sending to the network through {phase.host ?? 'your Electrum server'} ·{' '}
            <span className="num">{elapsedText}</span>.
          </p>
          {txChip}
        </div>
      );
    case 'broadcast_unknown':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg">
            AtPrice couldn’t confirm the broadcast. Transaction {txChip} may or may not have reached the
            network.
          </p>
          {phase.check === 'not_found' ? (
            <p className="text-body-sm text-fg-secondary">
              The transaction isn’t on the network yet. You can send the same signed transaction again.
            </p>
          ) : null}
          {typeof phase.check === 'object' ? (
            <p className="text-body-sm text-status-failed">
              The lookup failed (<span className="hash text-mono-sm">{phase.check.error}</span>). Try again.
            </p>
          ) : null}
          <Footer>
            <Button
              variant="primary"
              onClick={() => void flow.checkAgain()}
              aria-busy={phase.check === 'checking' || undefined}
              aria-disabled={phase.check === 'checking' || undefined}
            >
              {phase.check === 'checking' ? 'Checking' : 'Check again'}
            </Button>
            {phase.check === 'not_found' ? (
              <Button variant="outline" onClick={() => void flow.broadcastAgain()}>
                Broadcast again
              </Button>
            ) : null}
          </Footer>
          <AfterBroadcastLinks txid={phase.signed.txid} onClose={onClose} />
        </div>
      );
    case 'broadcast_rejected':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg">
            The network rejected the funding transaction: {phase.message}. Nothing was spent.
          </p>
          <Footer>
            {back}
            {tryAgain}
          </Footer>
        </div>
      );
    case 'registering':
    case 'registered':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg">Funding sent. Not confirmed yet.</p>
          {txChip}
          <p className="text-body-sm text-fg-secondary">Registering your order with AtPrice.</p>
          <Footer>
            <Link href={`/orders/${phase.txid}`} className={buttonVariants({ variant: 'outline' })}>
              View order
            </Link>
          </Footer>
        </div>
      );
    case 'register_failed':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-fg">
            Your order is funded on chain, but AtPrice couldn’t register it yet (
            <span className="hash text-mono-sm">{phase.code}</span>). Retrying every 15 s. Your order id is{' '}
            <span className="hash text-mono-sm break-all">{phase.txid}</span>. You can cancel it from Recover
            at any time.
          </p>
          <p className="text-body-sm text-fg-secondary">{FUNDS_STILL_SAFE}</p>
          <AfterBroadcastLinks txid={phase.txid} onClose={onClose} copyId />
        </div>
      );
  }
}

function ConfirmRow({
  back,
  reason,
  onConfirm,
}: {
  back: ReactNode;
  reason: string | null;
  onConfirm: () => void;
}) {
  const reasonId = useId();
  return (
    <div className="flex flex-col gap-2">
      <Footer>
        {back}
        <Button
          variant="primary"
          onClick={onConfirm}
          aria-disabled={reason !== null || undefined}
          aria-describedby={reason === null ? undefined : reasonId}
        >
          Confirm and sign in wallet
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

function AfterBroadcastLinks({
  txid,
  onClose,
  copyId = false,
}: {
  txid: string;
  onClose: () => void;
  copyId?: boolean;
}) {
  const orderId = `${txid}:0`;
  const { state, copy } = useCopy(orderId);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {copyId ? (
          <Button variant="outline" size="compact" onClick={() => void copy()}>
            {state === 'copied' ? 'Copied' : 'Copy order id'}
          </Button>
        ) : null}
        <Link href="/recover" className={buttonVariants({ variant: 'outline', size: 'compact' })}>
          Open in Recover
        </Link>
        <Link href={`/orders/${txid}`} className={buttonVariants({ variant: 'outline', size: 'compact' })}>
          View order
        </Link>
        <Button variant="ghost" size="compact" onClick={onClose}>
          Close
        </Button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={state === 'failed' ? 'text-body-sm text-status-failed' : 'sr-only'}
      >
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? `Copy failed. Select the text instead: ${orderId}`
            : ''}
      </p>
    </div>
  );
}

/** The two buttons sit in a sticky footer inside the sheet below md (funding-confirmation.md "390"). */
function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-5 flex flex-col-reverse gap-3 border-t border-border bg-surface px-5 py-3 md:static md:mx-0 md:flex-row md:justify-end md:border-0 md:bg-transparent md:p-0">
      {children}
    </div>
  );
}
