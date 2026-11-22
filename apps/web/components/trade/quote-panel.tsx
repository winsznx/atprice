import type { MarketDefinition, OrderSide, PriceRatio } from '@atprice/core';
import {
  HourglassMediumIcon,
  SealCheckIcon,
  WarningIcon,
  WarningOctagonIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';
import { BchAmount, Rate, TokenAmount } from '@/components/amount';
import { HashChip } from '@/components/hash-chip';
import { LocalTime } from '@/components/local-time';
import { ErrorState, FUNDS_STILL_SAFE } from '@/components/states';
import { StaleBadge } from '@/components/status-badge';
import { WithAssetLogo } from '@/components/token-logo';
import { Skeleton } from '@/components/ui/skeleton';
import type { Quote } from '@/lib/api/schemas';
import { formatBlockHeight, formatPercent, orientRate } from '@/lib/format';
import { BCH_ASSET } from '@/lib/token-logos';
import { cn } from '@/lib/utils';
import { limitVersusRate } from './terms';

export type QuoteView =
  | { readonly kind: 'no_amount' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly quote: Quote; readonly updating: boolean; readonly stale: boolean }
  | { readonly kind: 'unavailable'; readonly amountText: string; readonly code: string }
  | { readonly kind: 'error'; readonly code: string; readonly message: string; readonly retry: () => void };

type Severity = 'none' | 'high' | 'very_high';

/** DD 7.3: under 1% no word, 1% to under 5% `High`, 5% and above `Very high`. */
export const impactSeverity = (impact: { numerator: bigint; denominator: bigint }): Severity => {
  if (impact.numerator * 100n >= impact.denominator * 5n) return 'very_high';
  if (impact.numerator * 100n >= impact.denominator) return 'high';
  return 'none';
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <dt className="text-body-sm text-fg-muted">{label}</dt>
      <dd className="text-right text-num-md text-fg">{children}</dd>
    </div>
  );
}

export function QuotePanel({
  market,
  side,
  view,
  limitPrice,
  minProceeds,
  lowLiquidityNote,
}: {
  market: MarketDefinition;
  side: OrderSide;
  view: QuoteView;
  limitPrice: PriceRatio | null;
  /** Buy: `minOut` tokens. Sell: net proceeds `P` in sats (DD 4.1). Null until the terms are complete. */
  minProceeds: bigint | null;
  lowLiquidityNote: string | null;
}) {
  const tokenUnit = `${market.symbol} per BCH`;
  return (
    <section aria-labelledby="quote-title" aria-live="off" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="quote-title" className="font-display text-heading-3 text-fg">
          If it filled now
        </h2>
        {view.kind === 'ready' && view.stale ? <StaleBadge /> : null}
        {view.kind === 'ready' && view.updating && !view.stale ? (
          <span className="text-caption text-fg-muted">Updating</span>
        ) : null}
      </div>
      {lowLiquidityNote === null ? null : (
        <p className="text-body-sm text-fg-secondary">{lowLiquidityNote}</p>
      )}
      <QuoteBody
        market={market}
        side={side}
        view={view}
        limitPrice={limitPrice}
        minProceeds={minProceeds}
        tokenUnit={tokenUnit}
      />
      <p className="text-body-sm text-fg-muted">
        AtPrice’s keeper re-checks every pool before it submits and uses the best single public pool. That is
        AtPrice’s policy, not a contract rule: the contract guarantees only your minimum.
      </p>
    </section>
  );
}

function QuoteBody({
  market,
  side,
  view,
  limitPrice,
  minProceeds,
  tokenUnit,
}: {
  market: MarketDefinition;
  side: OrderSide;
  view: QuoteView;
  limitPrice: PriceRatio | null;
  minProceeds: bigint | null;
  tokenUnit: string;
}) {
  switch (view.kind) {
    case 'no_amount':
      return (
        <p className="text-body-sm text-fg-secondary">
          Enter an amount to see what one pool would pay for it right now.
        </p>
      );
    case 'loading':
      return (
        <div aria-busy="true" className="flex flex-col gap-3">
          <p role="status" className="sr-only">
            Loading the quote
          </p>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      );
    case 'unavailable':
      return (
        <dl className="flex flex-col divide-y divide-border">
          <div className="py-2 text-body-sm text-fg">
            <dt className="sr-only">You would receive</dt>
            <dd>{`No single pool can take ${view.amountText} right now.`}</dd>
          </div>
          <Row label="Versus your limit">
            <span className="text-body-sm text-status-pending">Cannot fill at this size today.</span>
          </Row>
          <p className="hash pt-2 text-mono-sm text-fg-muted">{view.code}</p>
        </dl>
      );
    case 'error':
      return (
        <ErrorState
          what={`The quote couldn’t be loaded: ${view.message}`}
          code={view.code}
          stillWorks={FUNDS_STILL_SAFE}
          onRetry={view.retry}
        />
      );
    case 'ready':
      return (
        <ReadyQuote
          market={market}
          side={side}
          view={view}
          limitPrice={limitPrice}
          minProceeds={minProceeds}
          tokenUnit={tokenUnit}
        />
      );
  }
}

function ReadyQuote({
  market,
  side,
  view,
  limitPrice,
  minProceeds,
  tokenUnit,
}: {
  market: MarketDefinition;
  side: OrderSide;
  view: Extract<QuoteView, { kind: 'ready' }>;
  limitPrice: PriceRatio | null;
  minProceeds: bigint | null;
  tokenUnit: string;
}) {
  const { quote } = view;
  const muted = view.updating || view.stale;
  const rate = orientRate(quote.effectiveRate, market.decimals, 'tokens_per_bch');
  const severity = impactSeverity(quote.priceImpact);
  const impactText = formatPercent(quote.priceImpact.numerator, quote.priceImpact.denominator);
  const outpoint = `${quote.pool.outpoint.txid}:${quote.pool.outpoint.vout}`;

  let versus: ReactNode;
  if (minProceeds === null || limitPrice === null) {
    versus = <span className="text-body-sm text-fg-muted">Enter a limit price to compare.</span>;
  } else if (quote.amountOut >= minProceeds) {
    versus = (
      <span className="inline-flex items-center gap-1 text-body-sm text-status-filled">
        <SealCheckIcon aria-hidden="true" className="size-4" />
        Your limit is reachable now
      </span>
    );
  } else {
    const gap = limitVersusRate(side, limitPrice, quote.effectiveRate);
    versus = (
      <span className="num inline-flex items-center gap-1 text-body-sm text-status-pending">
        <HourglassMediumIcon aria-hidden="true" className="size-4" />
        {`Needs a ${formatPercent(gap.numerator, gap.denominator)} better rate`}
      </span>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', muted && '[&_dd]:text-fg-muted')}>
      <dl className="flex flex-col divide-y divide-border">
        <Row label="You would receive">
          {side === 'buy' ? (
            <WithAssetLogo asset={market.tokenCategory}>
              <TokenAmount
                units={quote.amountOut}
                decimals={market.decimals}
                symbol={market.symbol}
                mode="compact"
              />
            </WithAssetLogo>
          ) : (
            <WithAssetLogo asset={BCH_ASSET}>
              <BchAmount sats={quote.amountOut} mode="compact" />
            </WithAssetLogo>
          )}
        </Row>
        <Row label="Effective rate">
          <Rate numerator={rate.numerator} denominator={rate.denominator} unit={tokenUnit} />
        </Row>
        <Row label="Price impact">
          <span
            className={cn(
              'num inline-flex items-center gap-1',
              severity === 'high' && 'text-status-pending',
              severity === 'very_high' && 'text-status-failed',
            )}
          >
            {severity === 'high' ? <WarningIcon aria-hidden="true" className="size-4" /> : null}
            {severity === 'very_high' ? <WarningOctagonIcon aria-hidden="true" className="size-4" /> : null}
            {impactText}
            {severity === 'high' ? ' High' : severity === 'very_high' ? ' Very high' : ''}
          </span>
        </Row>
        <Row label="Best pool">
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            <HashChip value={outpoint} kind="outpoint" label={`Best pool outpoint ${outpoint}`} />
            <span className="num text-body-sm text-fg-muted">{`of ${quote.poolsChecked.toLocaleString('en-US')} pools checked`}</span>
          </span>
        </Row>
        <Row label="Versus your limit">{versus}</Row>
      </dl>
      {severity === 'very_high' ? (
        <p className="text-body-sm text-status-failed">
          Your order is large for this pool. It fills only if the pool can still pay your minimum.
        </p>
      ) : null}
      <p className="num text-caption text-fg-muted">
        Quote from <LocalTime iso={quote.calculatedAt} /> (block {formatBlockHeight(quote.blockHeight)}).
        Refreshes every 10 s.
      </p>
    </div>
  );
}
