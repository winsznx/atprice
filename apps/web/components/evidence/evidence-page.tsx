'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { FileMagnifyingGlassIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { EmptyState, ErrorState, InlineAlert, LoadingRegion } from '@/components/states';
import { ToneBadge } from '@/components/status-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFailure, isUnreachable } from '@/lib/api/errors';
import { queries } from '@/lib/api/queries';
import { truncateMiddle } from '@/lib/format';
import { useNetworkCheck } from '@/lib/hooks/use-network-check';
import { appNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { EvidenceCard } from './evidence-card';
import { EVIDENCE_PAGE_SIZE, orderSearchState } from './evidence-logic';

export const EVIDENCE_REFRESH_MS = 60_000;

const isMainnet = appNetwork.network === 'mainnet';

export function evidenceIntro(openOrders: number | null | undefined): string {
  const base = isMainnet
    ? 'Every completed AtPrice order on mainnet, read from the blockchain. Some were placed by the AtPrice team to test the product; all amounts and prices are real.'
    : 'Every completed AtPrice order on chipnet, read from the blockchain. Chipnet uses test coins with no value; some orders were placed by the AtPrice team to test the product.';
  if (openOrders === undefined || openOrders === null) return base;
  return `${base} ${openOrders.toLocaleString('en-US')} ${openOrders === 1 ? 'order' : 'orders'} open now.`;
}

/** evidence.md "Error": the unreachable case has its own sentence; other failures name themselves. */
export const listFailure = (error: unknown): { what: string; code: string } => {
  const failure = apiFailure(error, 'The list can’t load.');
  return isUnreachable(error)
    ? { what: `AtPrice’s server is not responding (${failure.code}), so the list can’t load.`, code: failure.code }
    : failure;
};

export const emptyEvidenceText = `No completed AtPrice orders on ${appNetwork.name} yet.`;

function GenuineBadge({ mismatch }: { mismatch: boolean }) {
  if (mismatch) return <ToneBadge tone="failed" label="Network mismatch" />;
  if (isMainnet) {
    return (
      <span>
        <span className="sr-only">Genuine mainnet transactions, read from the blockchain</span>
        <span aria-hidden="true">
          <ToneBadge tone="filled" label="Genuine mainnet transactions" />
        </span>
      </span>
    );
  }
  return (
    <span>
      <span className="sr-only">Chipnet test transactions, read from the blockchain</span>
      <span aria-hidden="true">
        <ToneBadge tone="pending" label="Chipnet test transactions" />
      </span>
    </span>
  );
}

function CardSkeletons() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1].map((key) => (
        <div key={key} className="flex flex-col gap-4 rounded-lg border border-border p-(--space-panel)">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-5/6" />
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-8 w-[197px] max-w-full" />
          <Skeleton className="h-8 w-[197px] max-w-full" />
        </div>
      ))}
    </div>
  );
}

/** `/evidence` (evidence.md): every completed order on this network, each re-checkable from the browser. */
export function EvidencePage({ orderTxid }: { orderTxid: string | null }) {
  const network = useNetworkCheck();
  const networkStatus = useQuery({ ...queries.network(), refetchInterval: EVIDENCE_REFRESH_MS });
  const evidence = useInfiniteQuery({
    ...queries.evidencePages(EVIDENCE_PAGE_SIZE),
    refetchInterval: EVIDENCE_REFRESH_MS,
  });
  const pages = evidence.data?.pages ?? [];
  const orders = pages.flatMap((page) => page.orders);
  const search = orderSearchState(orderTxid, pages, evidence.hasNextPage);
  const { fetchNextPage, isFetchingNextPage } = evidence;
  const [focusFrom, setFocusFrom] = useState<number | null>(null);

  // `?order=`: keep loading pages (at most 5) until the order appears or the list ends.
  const searching = search.kind === 'searching' && evidence.data !== undefined;
  useEffect(() => {
    if (searching && !isFetchingNextPage) void fetchNextPage();
  }, [searching, isFetchingNextPage, fetchNextPage]);

  const mismatch = network.status === 'mismatch';
  const openOrders = networkStatus.data?.metrics?.openOrders;

  let list;
  if (mismatch) {
    list = (
      <InlineAlert tone="error" role="alert" title="This list is hidden while the networks differ">
        <p>
          {`This page is built for ${appNetwork.name}, but AtPrice’s server reports ${network.api}. The list could come from a different network than the page claims, so it isn’t shown.`}
        </p>
        <p className="hash text-mono-sm text-fg">NETWORK_MISMATCH</p>
      </InlineAlert>
    );
  } else if (evidence.data !== undefined) {
    list =
      orders.length === 0 ? (
        <EmptyState
          icon={FileMagnifyingGlassIcon}
          title="Nothing completed yet"
          action={
            <Link href="/trade" className={buttonVariants({ variant: 'primary' })}>
              Place a limit order
            </Link>
          }
        >
          {emptyEvidenceText}{' '}
          {openOrders === undefined || openOrders === null ? null : (
            <>
              Open orders right now: <span className="num">{openOrders.toLocaleString('en-US')}</span>.
            </>
          )}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {orders.map((order, index) => {
            const found = search.kind === 'found' && search.order.id === order.id;
            return (
              <EvidenceCard
                key={order.id}
                order={order}
                feesOpen={found}
                focus={found ? 'scroll' : index === focusFrom ? 'focus' : undefined}
              />
            );
          })}
          {evidence.hasNextPage ? (
            <div>
              <Button
                variant="outline"
                aria-disabled={isFetchingNextPage || undefined}
                onClick={() => {
                  setFocusFrom(orders.length);
                  void fetchNextPage();
                }}
              >
                {isFetchingNextPage ? 'Loading older orders' : 'Load older'}
              </Button>
            </div>
          ) : null}
          {evidence.isFetchNextPageError ? (
            <ErrorState
              {...apiFailure(evidence.error, 'Older orders can’t load.')}
              onRetry={() => void fetchNextPage()}
              retrying={isFetchingNextPage}
            />
          ) : null}
        </div>
      );
  } else if (evidence.isError) {
    list = (
      <div className="flex flex-col gap-3">
        <ErrorState
          {...listFailure(evidence.error)}
          onRetry={() => void evidence.refetch()}
          retrying={evidence.isFetching}
        />
        <p className="max-w-[64ch] text-body-sm text-fg-secondary">
          You can still check AtPrice transactions directly: paste a funding transaction id into{' '}
          <Link href="/recover" className="text-link underline underline-offset-4">
            Recover
          </Link>
          , which reads the chain without AtPrice’s server.
        </p>
      </div>
    );
  } else {
    list = (
      <LoadingRegion thing="completed orders" onRetry={() => void evidence.refetch()}>
        <CardSkeletons />
      </LoadingRegion>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-heading-2 text-fg md:text-heading-1">
            {isMainnet ? 'Evidence' : 'Evidence (chipnet)'}
          </h1>
          <GenuineBadge mismatch={mismatch} />
        </div>
        <p className="max-w-[64ch] text-body text-fg-secondary">{evidenceIntro(openOrders)}</p>
      </header>

      {search.kind === 'not_found' && !mismatch ? (
        <InlineAlert tone="info" role="status">
          <p>
            {`Order ${truncateMiddle(search.txid)} isn’t a completed AtPrice order on ${appNetwork.name}. `}
            <Link href={`/orders/${search.txid}`} className="text-link underline underline-offset-4">
              Open its order page
            </Link>
          </p>
        </InlineAlert>
      ) : null}

      {list}

      <div className={cn('flex max-w-[64ch] flex-col gap-3 text-body-sm text-fg-secondary')}>
        <p>
          Any party may fill an order at exactly its limit. AtPrice’s keeper uses the best single public pool; that
          is AtPrice’s policy, not a contract guarantee. “Filled by” says which fills AtPrice’s own keeper sent;
          the chain itself doesn’t record the filler.
        </p>
        <p>
          How to check this yourself: open any transaction in an explorer. The funding transaction carries an ATPR
          record that Recover decodes without AtPrice’s server. The contract source is in the repository.
        </p>
      </div>
    </div>
  );
}
