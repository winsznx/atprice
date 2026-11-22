import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ProhibitInsetIcon } from '@/components/client-icons';
import { ErrorState, EmptyState, FUNDS_STILL_SAFE } from '@/components/states';
import { PairLogos, TokenLogo } from '@/components/token-logo';
import {
  marketByCategory,
  marketSlug,
  pairText,
  tradeMarkets,
} from '@/components/trade/market';
import { buttonVariants } from '@/components/ui/button';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import type { MarketSummary } from '@/lib/api/schemas';
import { defaultMarket } from '@/lib/markets';
import { cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Trade',
  description: 'Place a limit order on a Bitcoin Cash token market.',
};

/** The market list changes with pool liquidity, so `/trade` decides on every request. */
export const dynamic = 'force-dynamic';

type Listing =
  | { readonly kind: 'ok'; readonly markets: readonly MarketSummary[] }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

const loadMarkets = async (): Promise<Listing> => {
  try {
    return { kind: 'ok', markets: await api.markets() };
  } catch (error) {
    if (!isApiError(error)) throw error;
    return { kind: 'error', code: error.displayCode, message: error.message };
  }
};

/**
 * trade.md "Route": `/trade` redirects (307) to the open market with the most liquidity. With no open
 * market it renders the no-market state itself, so nothing can be funded.
 */
export default async function TradeIndexPage() {
  const listing = await loadMarkets();
  if (listing.kind === 'ok') {
    const summary = defaultMarket(listing.markets);
    const market = summary === undefined ? undefined : marketByCategory(summary.tokenId);
    if (market !== undefined) redirect(`/trade/${marketSlug(market)}`);
  }
  return (
    <div className="mx-auto flex w-full max-w-(--container-content) flex-col gap-6 px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12">
      <h1 className="font-display text-heading-2 text-fg md:text-heading-1">Trade</h1>
      {listing.kind === 'error' ? (
        <>
          <ErrorState
            what={`AtPrice’s server didn’t list its markets: ${listing.message}`}
            code={listing.code}
            stillWorks={FUNDS_STILL_SAFE}
          />
          <ul className="flex flex-wrap gap-3">
            {tradeMarkets().map((market) => (
              <li key={market.tokenCategory}>
                <Link
                  href={`/trade/${marketSlug(market)}`}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  <PairLogos tokenCategory={market.tokenCategory} symbol={market.symbol} />
                  {`Open ${pairText(market)}`}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/recover" className={cn(buttonVariants({ variant: 'link' }))}>
                Recover an order
              </Link>
            </li>
          </ul>
        </>
      ) : (
        <EmptyState
          icon={ProhibitInsetIcon}
          title="No market is open"
          action={
            <Link href="/markets" className={buttonVariants({ variant: 'primary' })}>
              See markets
            </Link>
          }
        >
          No market is open for orders right now.
        </EmptyState>
      )}
      {listing.kind === 'ok' ? (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {listing.markets.map((summary) => {
            const market = marketByCategory(summary.tokenId);
            return (
              <li key={summary.tokenId} className="flex flex-col gap-1 p-4">
                <span className="flex items-center gap-1.5 text-label text-fg">
                  {market === undefined ? (
                    <TokenLogo asset={summary.tokenId} symbol={summary.symbol} />
                  ) : (
                    <PairLogos tokenCategory={market.tokenCategory} symbol={market.symbol} />
                  )}
                  {market === undefined ? summary.symbol : pairText(market)}
                </span>
                <span className="text-body-sm text-fg-secondary">
                  {summary.availability === 'paused'
                    ? `Paused: ${summary.availabilityReason ?? 'no reason was given'}`
                    : summary.verified
                      ? 'Open'
                      : 'Token identity not verified'}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
