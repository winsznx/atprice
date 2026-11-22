import { SELL_ORDER_SATS, type MarketDefinition } from '@atprice/core';
import Link from 'next/link';
import { BchAmount, Rate, TokenAmount } from '@/components/amount';
import { HashChip } from '@/components/hash-chip';
import { LocalTime } from '@/components/local-time';
import { ErrorState, FUNDS_STILL_SAFE } from '@/components/states';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { EvidenceOrder, MarketDetail } from '@/lib/api/schemas';
import { formatBch, formatBlockHeight, formatPercent, formatToken, orientRate } from '@/lib/format';
import { cn } from '@/lib/utils';

export type MarketDetailView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly code: string; readonly message: string; readonly retry: () => void }
  | { readonly kind: 'ready'; readonly detail: MarketDetail };

/** Market stats: above the form on phones, the top of the left panel from lg (trade.md "Layout"). */
export function MarketStats({ market, view }: { market: MarketDefinition; view: MarketDetailView }) {
  if (view.kind === 'loading') {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        <p role="status" className="sr-only">
          Loading market data
        </p>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }
  if (view.kind === 'error') {
    return (
      <div className="flex flex-col gap-3">
        <ErrorState what={view.message} code={view.code} stillWorks={FUNDS_STILL_SAFE} onRetry={view.retry} />
        <Link href="/recover" className={cn(buttonVariants({ variant: 'link' }), 'self-start')}>
          Recover an order without AtPrice’s server
        </Link>
      </div>
    );
  }
  const { detail } = view;
  const unit = `${market.symbol} per BCH`;
  const spot = detail.spotRate.value;
  const change = detail.change24h.value;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-label text-fg-muted">Rate now</p>
        {spot === null ? (
          <p
            className="text-body text-fg-muted"
            aria-label={`Rate not available: ${detail.spotRate.reason ?? ''}`}
          >
            Not available
          </p>
        ) : (
          <Rate
            {...orientRate(spot, market.decimals, 'tokens_per_bch')}
            unit={unit}
            size="xl"
            className="text-fg"
          />
        )}
        {change === null ? (
          <p className="text-body-sm text-fg-muted">24h change not available yet</p>
        ) : (
          <p
            className={cn(
              'num text-body-sm',
              change.numerator > 0n
                ? 'text-status-filled'
                : change.numerator < 0n
                  ? 'text-status-failed'
                  : 'text-fg-muted',
            )}
          >
            {`${formatPercent(change.numerator, change.denominator, { signed: true })} 24h`}
          </p>
        )}
        {detail.observedAt === null ? null : (
          <p className="num text-caption text-fg-muted">
            Observed <LocalTime iso={detail.observedAt} />
            {detail.blockHeight === null ? '' : `, block ${formatBlockHeight(detail.blockHeight)}`}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-label text-fg-muted">Pool liquidity</p>
        <p className="num text-num-md text-fg">
          {`${formatToken(detail.liquidity.tokens, market.decimals, 'compact')} ${market.symbol} · ${formatBch(detail.liquidity.sats, 'compact')} BCH`}
        </p>
        <p className="num text-body-sm text-fg-muted">{`${detail.poolCount.toLocaleString('en-US')} pools`}</p>
      </div>
    </div>
  );
}

export type RecentFillsView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly code: string; readonly retry: () => void }
  | { readonly kind: 'ready'; readonly fills: readonly EvidenceOrder[] };

/**
 * Recent fills for this market, from `GET /evidence` (AtPrice's completed real transactions). No rate
 * chart is drawn: the API serves no rate history, and PRD 7.1 asks for a chart only when reliable data
 * exists.
 */
export function MarketHistory({ market, fills }: { market: MarketDefinition; fills: RecentFillsView }) {
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="fills-title" className="flex flex-col gap-3">
        <h2 id="fills-title" className="font-display text-heading-3 text-fg">
          Recent fills on AtPrice
        </h2>
        <RecentFills market={market} view={fills} />
      </section>
    </div>
  );
}

function RecentFills({ market, view }: { market: MarketDefinition; view: RecentFillsView }) {
  if (view.kind === 'loading') {
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <p role="status" className="sr-only">
          Loading recent fills
        </p>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (view.kind === 'error') {
    return <ErrorState what="Recent fills couldn’t be loaded." code={view.code} onRetry={view.retry} />;
  }
  if (view.fills.length === 0) {
    return (
      <p className="text-body-sm text-fg-secondary">
        No completed fills in this market yet.{' '}
        <Link href="/evidence" className="text-link underline underline-offset-4">
          See every completed transaction
        </Link>
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {view.fills.map((order) => {
        if (order.settlement.kind !== 'fill') return null;
        const fill = order.settlement;
        return (
          <li key={order.id} className="flex flex-col gap-1 py-2">
            <p className="num flex flex-wrap items-baseline gap-x-2 text-body-sm text-fg">
              <LocalTime iso={order.settlementBlock.time} className="text-fg-muted" />
              <span className={order.side === 'buy' ? 'text-buy' : 'text-sell'}>
                {order.side === 'buy' ? 'Buy' : 'Sell'}
              </span>
              {order.side === 'buy' ? (
                <>
                  <BchAmount sats={order.amount} mode="compact" />
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">for</span>
                  <TokenAmount
                    units={fill.received}
                    decimals={market.decimals}
                    symbol={market.symbol}
                    mode="compact"
                  />
                </>
              ) : (
                <>
                  <TokenAmount
                    units={order.amount}
                    decimals={market.decimals}
                    symbol={market.symbol}
                    mode="compact"
                  />
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">for</span>
                  <BchAmount sats={fill.received - SELL_ORDER_SATS} mode="compact" />
                </>
              )}
            </p>
            <HashChip value={fill.txid} kind="tx" label={`Fill transaction ${fill.txid}`} />
          </li>
        );
      })}
      <li className="pt-2">
        <Link href="/evidence" className="text-body-sm text-link underline underline-offset-4">
          See every completed transaction
        </Link>
      </li>
    </ul>
  );
}
