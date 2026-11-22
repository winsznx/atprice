'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ErrorState, LoadingRegion } from '@/components/states';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queries } from '@/lib/api/queries';
import type { MarketDetail } from '@/lib/api/schemas';
import { apiFailure } from '@/lib/api/errors';
import { MarketDetailView } from './market-detail';
import { identityOf, type MarketIdentity } from './market-logic';

export function MarketNotFound() {
  return (
    <div className="flex max-w-[35rem] flex-col items-start gap-4">
      <h1 className="font-display text-heading-2 text-fg md:text-heading-1">Market not found</h1>
      <p className="text-body text-fg-secondary">This market does not exist on AtPrice.</p>
      <Link href="/markets" className={buttonVariants({ variant: 'primary' })}>
        See markets
      </Link>
    </div>
  );
}

/** Used only when the server render couldn't reach the API: the slug is resolved here instead. */
function ClientResolved({ slug }: { slug: string }) {
  const markets = useQuery(queries.markets());
  if (markets.data !== undefined) {
    const summary = markets.data.find((market) => market.slug === slug);
    if (summary === undefined) return <MarketNotFound />;
    return <MarketDetailView identity={identityOf(summary)} initialDetail={null} />;
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-heading-2 text-fg md:text-heading-1">{slug}</h1>
      {markets.isError ? (
        <ErrorState
          {...apiFailure(markets.error, 'This market can’t load.')}
          onRetry={() => void markets.refetch()}
          retrying={markets.isFetching}
        />
      ) : (
        <LoadingRegion thing="market" onRetry={() => void markets.refetch()}>
          <Skeleton className="h-64 w-full rounded-lg" />
        </LoadingRegion>
      )}
    </div>
  );
}

export function MarketDetailPage({
  slug,
  identity,
  initialDetail,
}: {
  slug: string;
  identity: MarketIdentity | null;
  initialDetail: MarketDetail | null;
}) {
  if (identity === null) return <ClientResolved slug={slug} />;
  return <MarketDetailView identity={identity} initialDetail={initialDetail} />;
}
