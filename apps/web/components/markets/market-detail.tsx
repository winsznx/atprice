'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  ChartLineIcon,
  ListNumbersIcon,
  ProhibitInsetIcon,
  TrayIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { BchAmount, Rate, TokenAmount } from '@/components/amount';
import { HashChip } from '@/components/hash-chip';
import { PairLogos } from '@/components/token-logo';
import { LocalTime } from '@/components/local-time';
import { EmptyState, ErrorState, InlineAlert, LoadingRegion, DisabledReason } from '@/components/states';
import { StaleBadge, ToneBadge } from '@/components/status-badge';
import { Button, buttonVariants, CONTROL_TRANSITION } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { queries } from '@/lib/api/queries';
import type { MarketDetail, Pool } from '@/lib/api/schemas';
import { formatAge, formatBlockHeight, formatBch, formatToken, orientRate, truncateMiddle } from '@/lib/format';
import { useNetworkCheck } from '@/lib/hooks/use-network-check';
import { useNow } from '@/lib/hooks/use-now';
import { cn } from '@/lib/utils';
import { apiFailure } from '@/lib/api/errors';
import { AvailabilityBadge, AvailabilityReason, ChangeValue, SpotRate } from './market-bits';
import {
  activityAmounts,
  availabilityOf,
  marketActivity,
  poolDataStale,
  shortSymbol,
  sourceHosts,
  tradePath,
  type MarketIdentity,
} from './market-logic';

export const MARKET_REFRESH_MS = 15_000;
export const ACTIVITY_REFRESH_MS = 30_000;

function Panel({
  title,
  headingId,
  children,
  aside,
  className,
}: {
  title: ReactNode;
  headingId: string;
  children: ReactNode;
  aside?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex min-w-0 flex-col gap-(--space-stack) rounded-lg border border-border p-(--space-panel)', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-display text-heading-3 text-fg">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TradeButtons({ identity, pools }: { identity: MarketIdentity; pools: readonly Pool[] | undefined }) {
  const reasonId = useId();
  const symbol = shortSymbol(identity.symbol);
  const reason = pools === undefined ? 'Loading pools.' : pools.length === 0 ? 'No pool to fill against.' : null;
  if (reason !== null) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-3">
          <Button aria-disabled aria-describedby={reasonId}>{`Buy ${symbol}`}</Button>
          <Button variant="outline" aria-disabled aria-describedby={reasonId}>{`Sell ${symbol}`}</Button>
        </div>
        <DisabledReason id={reasonId}>{reason}</DisabledReason>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-3">
      <Link href={tradePath(identity.slug, 'buy')} className={buttonVariants({ variant: 'primary' })}>
        {`Buy ${symbol}`}
      </Link>
      <Link href={tradePath(identity.slug, 'sell')} className={buttonVariants({ variant: 'outline' })}>
        {`Sell ${symbol}`}
      </Link>
    </div>
  );
}

function TokenLine({ identity }: { identity: MarketIdentity }) {
  const hosts = sourceHosts(identity.sources);
  const via = hosts.length === 0 ? 'no recorded source' : hosts.join(', ');
  const decimals = `${identity.decimals} ${identity.decimals === 1 ? 'decimal' : 'decimals'}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body-sm text-fg-secondary">
      <p className="sr-only">{`${identity.name}, category id ${truncateMiddle(identity.tokenId)}, ${decimals}, verified via ${via}`}</p>
      <span aria-hidden="true" className="text-fg">
        {identity.name}
      </span>
      <span aria-hidden="true">category</span>
      <HashChip value={identity.tokenId} kind="token" label={`${identity.symbol} token category ${identity.tokenId}`} />
      <span aria-hidden="true" className="num">
        {decimals}
      </span>
      <span aria-hidden="true">{`verified via ${via}`}</span>
    </div>
  );
}

function RatePanel({
  detail,
  stale,
}: {
  detail: MarketDetail | undefined;
  stale: boolean;
}) {
  const headingId = useId();
  const historyId = useId();
  const now = useNow();
  const age =
    stale && detail !== undefined && detail.observedAt !== null && now !== null ? formatAge(now - Date.parse(detail.observedAt)) : undefined;
  return (
    <Panel title="Rate now" headingId={headingId} aside={stale ? <StaleBadge age={age} /> : undefined}>
      {detail === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-64 max-w-full" />
          <Skeleton className="h-5 w-48" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <SpotRate market={detail} size="xl" className={stale ? 'text-fg-muted' : 'text-fg'} />
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-fg-secondary">
            <ChangeValue change={detail.change24h} />
            <span aria-hidden="true">·</span>
            {detail.observedAt === null ? (
              <span>Not yet observed</span>
            ) : (
              <span>
                Observed <LocalTime iso={detail.observedAt} />
                {detail.blockHeight === null ? null : (
                  <>
                    , block <span className="num">{formatBlockHeight(detail.blockHeight)}</span>
                  </>
                )}
              </span>
            )}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-border pt-(--space-stack)">
        <h3 id={historyId} className="text-label font-semibold text-fg">
          Rate history
        </h3>
        <InlineAlert tone="info" icon={ChartLineIcon}>
          <p>AtPrice’s API doesn’t serve rate history, so no chart is drawn. The rate above is the latest pool observation.</p>
          <p className="hash text-mono-sm text-fg">HISTORY_ENDPOINT_MISSING</p>
        </InlineAlert>
      </div>
    </Panel>
  );
}

const poolRate = (pool: Pool, decimals: number) => orientRate(pool.spotRate, decimals, 'tokens_per_bch');

function PoolRateValue({ pool, identity }: { pool: Pool; identity: MarketIdentity }) {
  const rate = poolRate(pool, identity.decimals);
  if (pool.spotRate.numerator === 0n) return <span className="text-fg-muted">Not available</span>;
  return <Rate numerator={rate.numerator} denominator={rate.denominator} unit={`${shortSymbol(identity.symbol)} per BCH`} />;
}

const outpointOf = (pool: Pool): string => `${pool.outpoint.txid}:${pool.outpoint.vout}`;

function PoolsPanel({
  detail,
  identity,
  stale,
}: {
  detail: MarketDetail | undefined;
  identity: MarketIdentity;
  stale: boolean;
}) {
  const headingId = useId();
  const symbol = shortSymbol(identity.symbol);
  const pools = detail?.pools;
  return (
    <Panel
      title={
        <>
          Pools AtPrice can fill against
          {pools === undefined ? null : <span className="num">{` (${pools.length})`}</span>}
        </>
      }
      headingId={headingId}
      aside={stale ? <StaleBadge /> : undefined}
    >
      {pools === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : pools.length === 0 ? (
        <EmptyState icon={ProhibitInsetIcon} title="No pool" headingLevel={3}>
          No Cauldron pool for this token right now. AtPrice can’t fill orders without one.
        </EmptyState>
      ) : (
        <>
          <div className="hidden lg:block">
            <Table>
              <TableCaption>{`Cauldron pools for ${identity.symbol}, ${pools.length} ${pools.length === 1 ? 'pool' : 'pools'}`}</TableCaption>
              <colgroup>
                <col className="w-[228px]" />
                <col className="w-[112px]" />
                <col className="w-[136px]" />
                <col className="w-[128px]" />
              </colgroup>
              <TableHeader>
                <tr>
                  <TableHead className="px-3">Pool</TableHead>
                  <TableHead className="px-3 text-right">BCH</TableHead>
                  <TableHead className="px-3 text-right">
                    <span aria-hidden="true">{symbol}</span>
                    <span className="sr-only">{identity.symbol}</span>
                  </TableHead>
                  <TableHead className="px-3 text-right">Rate (per BCH)</TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {pools.map((pool) => (
                  <TableRow key={outpointOf(pool)}>
                    <TableCell className="px-3">
                      <HashChip value={outpointOf(pool)} kind="outpoint" label={`Pool outpoint ${outpointOf(pool)}`} />
                    </TableCell>
                    <TableCell className={cn('px-3 text-right text-num-sm', stale && 'text-fg-muted')}>
                      <span className="num" aria-label={`${formatBch(pool.sats, 'compact')} BCH`}>
                        {formatBch(pool.sats, 'compact')}
                      </span>
                    </TableCell>
                    <TableCell className={cn('px-3 text-right text-num-sm', stale && 'text-fg-muted')}>
                      <span
                        className="num"
                        aria-label={`${formatToken(pool.tokens, identity.decimals, 'compact')} ${identity.symbol}`}
                      >
                        {formatToken(pool.tokens, identity.decimals, 'compact')}
                      </span>
                    </TableCell>
                    <TableCell className={cn('px-3 text-right text-num-sm', stale && 'text-fg-muted')}>
                      <PoolRateValue pool={pool} identity={identity} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-3 lg:hidden" aria-label={`Cauldron pools for ${identity.symbol}`}>
            {pools.map((pool) => (
              <li key={outpointOf(pool)} className="flex flex-col gap-2 rounded-md bg-surface-sunken p-3">
                <HashChip value={outpointOf(pool)} kind="outpoint" label={`Pool outpoint ${outpointOf(pool)}`} />
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-num-sm text-fg">
                  <BchAmount sats={pool.sats} mode="compact" />
                  <TokenAmount units={pool.tokens} decimals={identity.decimals} symbol={symbol} mode="compact" />
                  <PoolRateValue pool={pool} identity={identity} />
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {detail === undefined ? null : (
        <dl className="grid gap-2 border-t border-border pt-(--space-stack) text-body-sm">
          <div className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-fg-muted">Total liquidity</dt>
            <dd className="text-num-sm text-fg">
              <BchAmount sats={detail.liquidity.sats} mode="compact" />
              <span aria-hidden="true"> · </span>
              <span className="sr-only"> and </span>
              <TokenAmount units={detail.liquidity.tokens} decimals={identity.decimals} symbol={symbol} mode="compact" />
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-fg-muted">Minimum order</dt>
            <dd className="text-num-sm text-fg">
              <BchAmount sats={detail.minOrder.buy} mode="compact" />
              <span aria-hidden="true"> / </span>
              <span className="sr-only"> to buy, or </span>
              <TokenAmount units={detail.minOrder.sell} decimals={identity.decimals} symbol={symbol} mode="compact" />
              <span className="sr-only"> to sell</span>
            </dd>
          </div>
        </dl>
      )}
    </Panel>
  );
}

function OpenOrdersPanel() {
  const headingId = useId();
  const network = useQuery({ ...queries.network(), refetchInterval: 60_000 });
  const openOrders = network.data?.metrics?.openOrders;
  return (
    <Panel title="Open orders on AtPrice" headingId={headingId}>
      <InlineAlert tone="info" icon={ListNumbersIcon}>
        <p>
          AtPrice’s API doesn’t list open orders by market, so this market’s limit prices can’t be shown.
          {openOrders === undefined || openOrders === null ? null : (
            <>
              {' '}
              Across every market, <span className="num">{openOrders.toLocaleString('en-US')}</span>{' '}
              {openOrders === 1 ? 'order is' : 'orders are'} open now.
            </>
          )}
        </p>
        <p className="hash text-mono-sm text-fg">OPEN_ORDERS_ENDPOINT_MISSING</p>
      </InlineAlert>
    </Panel>
  );
}

function ActivityPanel({ identity }: { identity: MarketIdentity }) {
  const headingId = useId();
  const evidence = useQuery({ ...queries.evidence(null), refetchInterval: ACTIVITY_REFRESH_MS });
  let body: ReactNode;
  if (evidence.data !== undefined) {
    const rows = marketActivity(evidence.data.orders, identity.tokenId);
    body =
      rows.length === 0 ? (
        <EmptyState icon={TrayIcon} title="No transactions yet" headingLevel={3}>
          No AtPrice transactions in this market yet.
        </EmptyState>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => {
            const amounts = activityAmounts(row);
            return (
              <li
                key={row.key}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-3 last:border-0"
              >
                <span className="text-caption text-fg-muted">
                  <LocalTime iso={row.time} />
                </span>
                <span className="text-label font-semibold text-fg">{row.kind}</span>
                <span className="text-num-sm text-fg">
                  {amounts.from}
                  {amounts.to === null ? null : (
                    <>
                      <span aria-hidden="true"> → </span>
                      <span className="sr-only"> for </span>
                      {amounts.to}
                    </>
                  )}
                </span>
                <HashChip value={row.txid} kind="tx" className="ml-auto" />
              </li>
            );
          })}
        </ul>
      );
  } else if (evidence.isError) {
    body = (
      <ErrorState
        {...apiFailure(evidence.error, 'Recent activity can’t load.')}
        onRetry={() => void evidence.refetch()}
        retrying={evidence.isFetching}
      />
    );
  } else {
    body = (
      <LoadingRegion thing="recent activity">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </LoadingRegion>
    );
  }
  return (
    <Panel title="Recent AtPrice activity" headingId={headingId}>
      <p className="text-body-sm text-fg-muted">Completed orders in this market: each fill or cancel and its funding.</p>
      {body}
    </Panel>
  );
}

function Breadcrumb({ identity }: { identity: MarketIdentity }) {
  return (
    <nav aria-label="Breadcrumb" className="text-body-sm">
      <ol className="hidden items-center gap-2 text-fg-secondary md:flex">
        <li>
          <Link href="/markets" className={cn('text-link underline underline-offset-4', CONTROL_TRANSITION)}>
            Markets
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li aria-current="page" className="text-fg">{`BCH / ${shortSymbol(identity.symbol)}`}</li>
      </ol>
      <Link
        href="/markets"
        className={cn('inline-flex min-h-(--size-control) items-center gap-1 text-link md:hidden', CONTROL_TRANSITION)}
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        Markets
      </Link>
    </nav>
  );
}

/** `/markets/[slug]` once the slug is resolved to a token (market-detail.md). */
export function MarketDetailView({
  identity,
  initialDetail,
}: {
  identity: MarketIdentity;
  initialDetail: MarketDetail | null;
}) {
  const detail = useQuery({
    ...queries.market(identity.tokenId),
    refetchInterval: MARKET_REFRESH_MS,
    ...(initialDetail === null ? {} : { initialData: initialDetail }),
  });
  const health = useQuery({ ...queries.health(), refetchInterval: MARKET_REFRESH_MS });
  const network = useNetworkCheck();
  const stale = poolDataStale(health.data);
  const availability = detail.data === undefined ? null : availabilityOf(detail.data, network.status === 'mismatch');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Breadcrumb identity={identity} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-heading-2 text-fg md:text-heading-1">
              <PairLogos
                tokenCategory={identity.tokenId}
                symbol={identity.symbol}
                size={32}
                className="mr-3 align-middle"
              />
              {`BCH / ${shortSymbol(identity.symbol)}`}
              {identity.symbol.length > shortSymbol(identity.symbol).length ? (
                <span className="sr-only">{`, full symbol ${identity.symbol}`}</span>
              ) : null}
            </h1>
            {availability === null ? null : <AvailabilityBadge display={availability} />}
          </div>
          <TradeButtons identity={identity} pools={detail.data?.pools} />
        </div>
        {availability === null ? null : <AvailabilityReason display={availability} />}
        <TokenLine identity={identity} />
        {detail.data?.verified === false ? <ToneBadge tone="pending" label="Unverified token" className="self-start" /> : null}
      </div>
      {detail.isError && detail.data === undefined ? (
        <ErrorState
          {...apiFailure(detail.error, 'This market’s rate and pools can’t load.')}
          onRetry={() => void detail.refetch()}
          retrying={detail.isFetching}
        />
      ) : null}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <RatePanel detail={detail.data} stale={stale} />
        <PoolsPanel detail={detail.data} identity={identity} stale={stale} />
        <OpenOrdersPanel />
        <ActivityPanel identity={identity} />
      </div>
    </div>
  );
}
