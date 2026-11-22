import { MarketNotFound } from '@/components/markets/market-detail-page';

export default function MarketNotFoundRoute() {
  return (
    <div className="mx-auto w-full max-w-(--container-app) px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12">
      <MarketNotFound />
    </div>
  );
}
