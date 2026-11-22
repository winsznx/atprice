'use client';

import { useQuery } from '@tanstack/react-query';
import { StorefrontIcon } from '@phosphor-icons/react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { LocalTime } from '@/components/local-time';
import { EmptyState, ErrorState, FUNDS_STILL_SAFE, InlineAlert, LoadingRegion } from '@/components/states';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { queries } from '@/lib/api/queries';
import type { MarketSummary } from '@/lib/api/schemas';
import { formatAge, formatBlockHeight } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { useNetworkCheck } from '@/lib/hooks/use-network-check';
import { apiFailure } from '@/lib/api/errors';
import { MarketCards, MarketCardsSkeleton, MarketsTable, MarketsTableSkeleton } from './markets-list';
import {
  latestObservation,
  nextSort,
  oldestObservation,
  parseSort,
  poolDataStale,
  sortMarkets,
  sortSearch,
  type MarketSort,
  type SortKey,
} from './market-logic';

export const MARKETS_REFRESH_MS = 30_000;
export const HOW_CHOSEN_ID = 'how-markets-are-chosen';

const SORT_OPTIONS: readonly { readonly sort: MarketSort; readonly label: string }[] = [
  { sort: { key: 'liquidity', dir: 'desc' }, label: 'Liquidity, highest first' },
  { sort: { key: 'liquidity', dir: 'asc' }, label: 'Liquidity, lowest first' },
  { sort: { key: 'change', dir: 'desc' }, label: '24h change, highest first' },
  { sort: { key: 'change', dir: 'asc' }, label: '24h change, lowest first' },
  { sort: { key: 'pair', dir: 'asc' }, label: 'Pair, A to Z' },
  { sort: { key: 'pair', dir: 'desc' }, label: 'Pair, Z to A' },
];

const sortValue = (sort: MarketSort): string => `${sort.key}:${sort.dir}`;

function Subline({ markets }: { markets: readonly MarketSummary[] }) {
  const latest = latestObservation(markets);
  return (
    <p className="max-w-[64ch] text-body text-fg-secondary">
      Bitcoin Cash token markets backed by Cauldron pools.{' '}
      {latest === null ? (
        'No pool data observed yet.'
      ) : (
        <>
          Data observed <LocalTime iso={latest.observedAt} />
          {latest.blockHeight === null ? (
            '.'
          ) : (
            <>
              , block <span className="num">{formatBlockHeight(latest.blockHeight)}</span>.
            </>
          )}
        </>
      )}
    </p>
  );
}

function StaleWarning({ markets }: { markets: readonly MarketSummary[] }) {
  const now = useNow();
  const oldest = oldestObservation(markets);
  const age = now === null || oldest === null ? null : formatAge(now - Date.parse(oldest));
  return (
    <InlineAlert tone="warning" role="status">
      {age === null
        ? 'Pool data is stale. Rates may have moved. Orders are paused until fresh data arrives.'
        : `Pool data is ${age} old. Rates may have moved. Orders are paused until fresh data arrives.`}
    </InlineAlert>
  );
}

function SortSelect({ sort, onChange }: { sort: MarketSort; onChange: (sort: MarketSort) => void }) {
  return (
    <div className="flex items-center gap-3 lg:hidden">
      <span id="markets-sort-label" className="text-label text-fg">
        Sort
      </span>
      <Select
        value={sortValue(sort)}
        onValueChange={(value) => {
          const option = SORT_OPTIONS.find((candidate) => sortValue(candidate.sort) === value);
          if (option !== undefined) onChange(option.sort);
        }}
      >
        <SelectTrigger aria-labelledby="markets-sort-label" className="min-w-[15rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((option) => (
            <SelectItem key={sortValue(option.sort)} value={sortValue(option.sort)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function HowChosen() {
  return (
    <section aria-labelledby={HOW_CHOSEN_ID} className="flex max-w-[64ch] flex-col gap-2">
      <h2 id={HOW_CHOSEN_ID} tabIndex={-1} className="scroll-mt-20 text-label font-semibold text-fg outline-none">
        How markets are chosen
      </h2>
      <p className="text-body-sm text-fg-secondary">
        A token is listed when its category id is verified and it has at least one Cauldron pool. Orders open
        when the pools hold enough liquidity for the minimum order to fill. A market is paused when pool data is
        stale or the token can’t be verified.
      </p>
    </section>
  );
}

/** `/markets` (markets.md): every market the API knows, sortable, with its availability and reason. */
export function MarketsPage({ initialMarkets }: { initialMarkets: readonly MarketSummary[] | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sort = parseSort(searchParams.get('sort'), searchParams.get('dir'));
  const network = useNetworkCheck();
  const markets = useQuery({
    ...queries.markets(),
    refetchInterval: MARKETS_REFRESH_MS,
    ...(initialMarkets === null ? {} : { initialData: initialMarkets }),
  });
  const health = useQuery({ ...queries.health(), refetchInterval: MARKETS_REFRESH_MS });

  const setSort = (next: MarketSort) => router.replace(`${pathname}${sortSearch(next)}`, { scroll: false });
  const onSort = (key: SortKey) => setSort(nextSort(sort, key));
  const mismatch = network.status === 'mismatch';

  let body;
  if (markets.data !== undefined) {
    const sorted = sortMarkets(markets.data, sort);
    body =
      sorted.length === 0 ? (
        <EmptyState
          icon={StorefrontIcon}
          title="No markets yet"
          action={
            <a href={`#${HOW_CHOSEN_ID}`} className="text-body text-link underline underline-offset-4">
              How markets are chosen
            </a>
          }
        >
          AtPrice has no markets yet. A market appears when a verified token has at least one Cauldron pool.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {poolDataStale(health.data) ? <StaleWarning markets={sorted} /> : null}
          <SortSelect sort={sort} onChange={setSort} />
          <div className="hidden lg:block">
            <MarketsTable markets={sorted} sort={sort} onSort={onSort} networkMismatch={mismatch} />
          </div>
          <div className="lg:hidden">
            <MarketCards markets={sorted} networkMismatch={mismatch} />
          </div>
        </div>
      );
  } else if (markets.isError) {
    body = (
      <ErrorState
        {...apiFailure(markets.error, 'The market list can’t load.')}
        stillWorks={FUNDS_STILL_SAFE}
        onRetry={() => void markets.refetch()}
        retrying={markets.isFetching}
      />
    );
  } else {
    body = (
      <LoadingRegion thing="markets" onRetry={() => void markets.refetch()}>
        <div className="hidden lg:block">
          <MarketsTableSkeleton />
        </div>
        <div className="lg:hidden">
          <MarketCardsSkeleton />
        </div>
      </LoadingRegion>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-heading-2 text-fg md:text-heading-1">Markets</h1>
        {markets.data === undefined ? (
          <p className="max-w-[64ch] text-body text-fg-secondary">Bitcoin Cash token markets backed by Cauldron pools.</p>
        ) : (
          <Subline markets={markets.data} />
        )}
      </header>
      {body}
      <HowChosen />
    </div>
  );
}
