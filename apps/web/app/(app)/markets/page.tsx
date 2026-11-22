import type { Metadata } from 'next';
import { MarketsPage } from '@/components/markets/markets-page';
import { loadMarkets } from '@/components/markets/server-data';
import { pageMetadata } from '@/lib/seo';

export const metadata: Metadata = pageMetadata({
  title: 'Markets',
  description:
    'Bitcoin Cash token markets backed by Cauldron pools, with live rates, liquidity and availability. Each one takes non-custodial limit orders.',
  path: '/markets',
});

export default async function MarketsRoute() {
  const markets = await loadMarkets();
  return (
    <div className="mx-auto w-full max-w-(--container-app) px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12">
      <MarketsPage initialMarkets={markets.ok ? markets.value : null} />
    </div>
  );
}
