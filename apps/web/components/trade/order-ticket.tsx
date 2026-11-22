'use client';

import type { MarketDefinition, OrderSide, PriceRatio } from '@atprice/core';
import { ArrowsLeftRightIcon, WarningOctagonIcon } from '@phosphor-icons/react';
import { useId, type ReactNode, type Ref } from 'react';
import { Rate } from '@/components/amount';
import { FeeDisclosure, type FeeDisclosureValues } from '@/components/fee-disclosure';
import { HashChip } from '@/components/hash-chip';
import { DisabledReason } from '@/components/states';
import { TokenLogo } from '@/components/token-logo';
import { Button, CONTROL_TRANSITION } from '@/components/ui/button';
import { formatPercent, orientRate, type RateOrientation } from '@/lib/format';
import { BCH_ASSET } from '@/lib/token-logos';
import { cn } from '@/lib/utils';
import { SideTabs } from './side-tabs';
import { OFFSETS_BPS, offsetLabel, type Fraction, type OffsetBps } from './terms';

export type BalanceLine =
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'unknown'; readonly code: string; readonly retry: () => void }
  | { readonly kind: 'known'; readonly text: string };

export type Enablement = { readonly enabled: true } | { readonly enabled: false; readonly reason: string };

export interface AmountProps {
  readonly text: string;
  readonly unit: string;
  readonly error: string | null;
  readonly balance: BalanceLine;
  readonly max: Enablement;
  readonly onChange: (text: string) => void;
  readonly onMax: () => void;
}

export interface LimitProps {
  readonly text: string;
  readonly orientation: RateOrientation;
  readonly unit: string;
  readonly invertedUnit: string;
  readonly error: string | null;
  /** `Rate now` (quote for the typed amount) or `Spot` (before an amount exists). */
  readonly reference: { readonly label: 'Rate now' | 'Spot'; readonly price: PriceRatio } | null;
  readonly offsetValue: (bps: OffsetBps) => string | null;
  readonly offsetLine: Fraction | null;
  readonly onChange: (text: string) => void;
  readonly onInvert: () => void;
  readonly onOffset: (bps: OffsetBps) => void;
}

export type RecipientProps =
  | { readonly mode: 'disconnected' }
  | { readonly mode: 'wallet'; readonly address: string; readonly onChange: () => void }
  | {
      readonly mode: 'custom';
      readonly text: string;
      readonly error: string | null;
      readonly onText: (text: string) => void;
      readonly onUseWallet: () => void;
    };

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1 text-body-sm text-status-failed">
      <WarningOctagonIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

const inputClass = cn(
  'num min-w-0 flex-1 bg-transparent py-2 pl-3 text-num-lg text-fg outline-none placeholder:text-fg-disabled',
  'aria-disabled:text-fg-disabled',
);

const fieldShell = (invalid: boolean) =>
  cn(
    'flex min-h-(--size-control-lg) w-full min-w-0 items-center rounded-md border bg-surface focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus',
    invalid ? 'border-status-failed' : 'border-border-input',
  );

const offsetText = (line: Fraction): string => {
  if (line.numerator === 0n) return 'Same as the rate now. This order can fill as soon as it is funded.';
  const magnitude = line.numerator < 0n ? -line.numerator : line.numerator;
  const percent = formatPercent(magnitude, line.denominator);
  return line.numerator > 0n
    ? `${percent} better than the rate now`
    : `${percent} worse than the rate now. This order can fill as soon as it is funded.`;
};

/**
 * DD 7.2 order ticket: side tabs, amount, limit with reference rate, offsets and invert, recipient,
 * fee row, then the action slot (the ticket's own button from lg, or the inline placement below lg).
 */
export function OrderTicket({
  market,
  side,
  onSideChange,
  loadingReason,
  undo,
  amount,
  limit,
  recipient,
  fees,
  action,
  statusCard,
  amountRef,
  limitRef,
  recipientRef,
}: {
  market: MarketDefinition;
  side: OrderSide;
  onSideChange: (side: OrderSide) => void;
  /** `Loading market data.` until the detail arrives; inputs stay focusable with this reason. */
  loadingReason: string | null;
  undo: (() => void) | null;
  amount: AmountProps;
  limit: LimitProps;
  recipient: RecipientProps;
  fees: FeeDisclosureValues | null;
  action: ReactNode;
  statusCard: ReactNode;
  amountRef: Ref<HTMLInputElement>;
  limitRef: Ref<HTMLInputElement>;
  recipientRef: Ref<HTMLInputElement>;
}) {
  const ids = {
    loading: useId(),
    amountLabel: useId(),
    amount: useId(),
    amountError: useId(),
    balance: useId(),
    maxReason: useId(),
    limit: useId(),
    limitError: useId(),
    offsetLine: useId(),
    offsetReason: useId(),
    recipient: useId(),
    recipientError: useId(),
    recipientReason: useId(),
  };
  const loading = loadingReason !== null;
  const offsetsEnabled = !loading && limit.reference !== null;
  const describe = (...values: (string | false | null)[]) => values.filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {loading ? (
        <DisabledReason id={ids.loading} className="sr-only">
          {loadingReason}
        </DisabledReason>
      ) : null}
      <SideTabs
        side={side}
        symbol={market.symbol}
        onSideChange={onSideChange}
        disabledReasonId={loading ? ids.loading : null}
      >
        {undo === null ? null : (
          <p role="status" className="flex flex-wrap items-center gap-2 text-body-sm text-fg-secondary">
            Amount and price cleared.
            <Button variant="link" onClick={undo} className="min-h-(--size-control-sm)">
              Undo
            </Button>
          </p>
        )}

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <label id={ids.amountLabel} htmlFor={ids.amount} className="text-label text-fg">
              You pay<span className="sr-only">{`, in ${amount.unit}`}</span>
            </label>
            <span className="flex flex-wrap items-center gap-2">
              <BalanceText id={ids.balance} balance={amount.balance} />
              <Button
                variant="outline"
                size="compact"
                onClick={amount.onMax}
                aria-disabled={!amount.max.enabled || loading || undefined}
                aria-describedby={amount.max.enabled ? undefined : ids.maxReason}
                className="min-h-(--size-control-sm)"
              >
                Max
              </Button>
            </span>
          </div>
          {amount.max.enabled ? null : (
            <DisabledReason id={ids.maxReason} className="text-right">
              {amount.max.reason}
            </DisabledReason>
          )}
          <div className={fieldShell(amount.error !== null)}>
            <input
              ref={amountRef}
              id={ids.amount}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="0.00"
              value={amount.text}
              readOnly={loading}
              aria-disabled={loading || undefined}
              aria-invalid={amount.error !== null || undefined}
              aria-describedby={describe(
                ids.balance,
                amount.error !== null && ids.amountError,
                loading && ids.loading,
              )}
              onChange={(event) => amount.onChange(event.target.value)}
              className={inputClass}
            />
            <span className="flex shrink-0 items-center gap-1.5 px-3 text-label text-fg-secondary">
              <TokenLogo asset={side === 'buy' ? BCH_ASSET : market.tokenCategory} symbol={amount.unit} />
              {amount.unit}
            </span>
          </div>
          <div aria-live="polite">
            {amount.error === null ? null : <FieldError id={ids.amountError}>{amount.error}</FieldError>}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <label htmlFor={ids.limit} className="text-label text-fg">
              Limit price<span className="sr-only">{`, ${limit.unit}`}</span>
            </label>
            <span className="flex flex-wrap items-center gap-1 text-body-sm text-fg-muted">
              {limit.reference === null ? (
                <span>No rate available yet</span>
              ) : (
                <span>
                  {`${limit.reference.label} `}
                  <Rate
                    {...orientRate(limit.reference.price, market.decimals, limit.orientation)}
                    unit={limit.unit}
                    className="text-fg-secondary"
                  />
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={limit.onInvert}
                aria-disabled={loading || undefined}
                aria-describedby={loading ? ids.loading : undefined}
                aria-label={`Show price as ${limit.invertedUnit}`}
              >
                <ArrowsLeftRightIcon aria-hidden="true" />
              </Button>
            </span>
          </div>
          <div className={fieldShell(limit.error !== null)}>
            <input
              ref={limitRef}
              id={ids.limit}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="0.00"
              value={limit.text}
              readOnly={loading}
              aria-disabled={loading || undefined}
              aria-invalid={limit.error !== null || undefined}
              aria-describedby={describe(
                limit.offsetLine !== null && ids.offsetLine,
                limit.error !== null && ids.limitError,
                loading && ids.loading,
              )}
              onChange={(event) => limit.onChange(event.target.value)}
              className={inputClass}
            />
            <span className="shrink-0 px-3 text-label text-fg-secondary">{limit.unit}</span>
          </div>
          <div role="group" aria-label="Set limit relative to the rate now" className="flex flex-wrap gap-2">
            {OFFSETS_BPS.map((bps) => {
              const value = limit.offsetValue(bps);
              return (
                <Button
                  key={bps}
                  variant="outline"
                  size="compact"
                  onClick={() => limit.onOffset(bps)}
                  aria-disabled={!offsetsEnabled || undefined}
                  aria-describedby={offsetsEnabled ? undefined : ids.offsetReason}
                  aria-label={
                    value === null
                      ? offsetLabel(bps)
                      : `${offsetLabel(bps)}, sets the limit to ${value} ${limit.unit}`
                  }
                  className="num min-h-(--size-control-sm) px-3"
                >
                  {offsetLabel(bps)}
                </Button>
              );
            })}
          </div>
          {offsetsEnabled ? null : (
            <DisabledReason id={ids.offsetReason}>
              {loading ? loadingReason : 'No rate available to offset from.'}
            </DisabledReason>
          )}
          <div aria-live="polite">
            {limit.error === null ? null : <FieldError id={ids.limitError}>{limit.error}</FieldError>}
          </div>
          {limit.offsetLine === null ? null : (
            <p
              id={ids.offsetLine}
              className={cn(
                'num text-body-sm',
                limit.offsetLine.numerator > 0n ? 'text-fg-secondary' : 'text-status-filled',
              )}
            >
              {offsetText(limit.offsetLine)}
            </p>
          )}
        </div>

        <RecipientRow recipient={recipient} ids={ids} inputRef={recipientRef} />

        {fees === null ? null : <FeeDisclosure values={fees} variant="ticket" />}

        {statusCard}
        {action}
      </SideTabs>
    </div>
  );
}

function BalanceText({ id, balance }: { id: string; balance: BalanceLine }) {
  switch (balance.kind) {
    case 'hidden':
      return null;
    case 'disconnected':
      return (
        <span id={id} className="text-body-sm text-fg-muted">
          Connect a wallet to see your balance
        </span>
      );
    case 'loading':
      return (
        <span id={id} className="text-body-sm text-fg-muted">
          Reading balance
        </span>
      );
    case 'unknown':
      return (
        <span id={id} className="flex items-center gap-2 text-body-sm text-status-failed">
          <span>
            Balance unknown (<span className="hash text-mono-sm">{balance.code}</span>)
          </span>
          <Button variant="link" onClick={balance.retry} className="min-h-(--size-control-sm)">
            Retry
          </Button>
        </span>
      );
    case 'known':
      return (
        <span id={id} className="num text-num-sm text-fg-secondary">
          {`Balance ${balance.text}`}
        </span>
      );
  }
}

function RecipientRow({
  recipient,
  ids,
  inputRef,
}: {
  recipient: RecipientProps;
  ids: { recipient: string; recipientError: string; recipientReason: string };
  inputRef: Ref<HTMLInputElement>;
}) {
  if (recipient.mode === 'custom') {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <label htmlFor={ids.recipient} className="text-label text-fg">
          Paid to
        </label>
        <input
          ref={inputRef}
          id={ids.recipient}
          autoComplete="off"
          spellCheck={false}
          value={recipient.text}
          aria-invalid={recipient.error !== null || undefined}
          aria-describedby={recipient.error === null ? undefined : ids.recipientError}
          onChange={(event) => recipient.onText(event.target.value)}
          className={cn(
            'hash min-h-(--size-control) w-full min-w-0 rounded-md border bg-surface px-3 text-mono-sm text-fg',
            recipient.error === null ? 'border-border-input' : 'border-status-failed',
          )}
        />
        <div aria-live="polite">
          {recipient.error === null ? null : (
            <FieldError id={ids.recipientError}>{recipient.error}</FieldError>
          )}
        </div>
        <Button
          variant="link"
          onClick={recipient.onUseWallet}
          className="min-h-(--size-control-sm) self-start"
        >
          Use my wallet
        </Button>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-body-sm text-fg-secondary">
        <span className="text-label text-fg">Paid to</span>
        {recipient.mode === 'wallet' ? (
          <HashChip
            value={recipient.address}
            kind="address"
            label={`Your wallet address ${recipient.address}`}
          />
        ) : null}
        <span>(your wallet)</span>
        <Button
          variant="link"
          onClick={recipient.mode === 'wallet' ? recipient.onChange : undefined}
          aria-disabled={recipient.mode === 'disconnected' || undefined}
          aria-describedby={recipient.mode === 'disconnected' ? ids.recipientReason : undefined}
          className={cn('min-h-(--size-control-sm)', CONTROL_TRANSITION)}
        >
          Change
        </Button>
      </div>
      {recipient.mode === 'disconnected' ? (
        <DisabledReason id={ids.recipientReason}>
          Connect a wallet first. Orders pay your wallet by default.
        </DisabledReason>
      ) : null}
    </div>
  );
}
