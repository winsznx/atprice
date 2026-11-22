'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CaretLeftIcon, GitDiffIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { CancelDialog } from '@/components/cancel/cancel-dialog';
import { ExplorerLink } from '@/components/explorer-link';
import { HashChip } from '@/components/hash-chip';
import { OrderTimeline } from '@/components/order-timeline';
import { EmptyState, ErrorState, InlineAlert, LoadingRegion } from '@/components/states';
import { STATUS_DISPLAY, StatusBadge } from '@/components/status-badge';
import { TransactionReceipt } from '@/components/transaction-receipt';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api/errors';
import { queries, queryKeys, shouldRetry } from '@/lib/api/queries';
import type { Order } from '@/lib/api/schemas';
import { useNetworkCheck } from '@/lib/hooks/use-network-check';
import { timelineSteps } from '@/lib/orders/timeline';
import { useWalletState } from '@/lib/wallet/store';
import { cn } from '@/lib/utils';
import { ExecutionCondition, KeeperChecks } from './keeper-panels';
import { CancelAction, CopyOrderIdButton, ShareButton } from './order-actions';
import {
  breadcrumbFor,
  cancelAvailability,
  orderRefreshInterval,
  ownershipOf,
  unexpectedSpend,
} from './order-detail';
import { titleBlock } from './order-title';
import { OrderTerms } from './order-terms';
import { isUnknownOrderError, resolveOrder } from './resolve-order';

const PAGE = 'mx-auto w-full max-w-(--container-content) px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12';

const recoverHref = (txid: string): string => `/recover?txid=${txid}`;

export const PRIVACY_NOTE =
  'Shared pages show the order’s terms and its transactions. They don’t show your address or your other orders. Transactions are public on the blockchain, so anyone who opens one in an explorer can see its addresses.';

/**
 * `/orders/[id]` (order-detail.md): the public share page, plus cancel for the connected owner.
 * `initialOrder` is the server-rendered public record, so link previews and first paint have it.
 */
export function OrderDetailScreen({ txid, initialOrder }: { txid: string; initialOrder: Order | null }) {
  const order = useQuery({
    queryKey: queryKeys.order(txid),
    queryFn: ({ signal }) => resolveOrder(txid, signal),
    ...(initialOrder === null ? {} : { initialData: initialOrder }),
    refetchInterval: (query) => orderRefreshInterval(query.state.data),
    retry: shouldRetry,
  });

  if (order.data !== undefined) return <OrderDetailView order={order.data} />;
  if (order.isPending) {
    return (
      <div className={PAGE}>
        <LoadingRegion thing="the order" onRetry={() => void order.refetch()} className="flex flex-col gap-6">
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-9 w-80 max-w-full" />
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-96 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
        </LoadingRegion>
      </div>
    );
  }
  const recover = (
    <Link href={recoverHref(txid)} className={buttonVariants({ variant: 'primary' })}>
      Open in Recover
    </Link>
  );
  if (isUnknownOrderError(order.error)) {
    return (
      <div className={PAGE}>
        <h1 className="sr-only">Order not found</h1>
        <EmptyState
          icon={MagnifyingGlassIcon}
          title="AtPrice has no record of this order."
          action={
            <div className="flex flex-wrap items-center gap-3">
              {recover}
              <ExplorerLink kind="tx" value={txid}>
                Open transaction in explorer
              </ExplorerLink>
            </div>
          }
        >
          If you funded it, it still exists on chain. Recover can find it from the funding transaction and cancel it
          without AtPrice’s server.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className={cn(PAGE, 'flex flex-col gap-4')}>
      <h1 className="font-display text-heading-2 text-fg md:text-heading-1">Order</h1>
      <ErrorState
        what="AtPrice can’t load this order right now."
        code={isApiError(order.error) ? order.error.displayCode : 'API_UNREACHABLE'}
        stillWorks="Your funds stay in their contracts. Recover can find this order from its funding transaction and cancel it without AtPrice’s server."
        onRetry={() => void order.refetch()}
        retrying={order.isFetching}
      />
      <div>{recover}</div>
    </div>
  );
}

function OrderDetailView({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const wallet = useWalletState();
  const network = useNetworkCheck();
  const ownership = ownershipOf(wallet, order.ownerPkh);
  const isOwner = ownership.kind === 'owner';
  const availability = cancelAvailability(order, ownership, network);
  const isOpen = order.status === 'OPEN';
  const market = useQuery({
    ...queries.market(order.tokenCategory),
    enabled: isOpen,
    refetchInterval: isOpen ? 15_000 : false,
  });
  const health = useQuery({ ...queries.health(), enabled: isOpen, refetchInterval: isOpen ? 60_000 : false });
  const markets = useQuery({ ...queries.markets(), enabled: !isOwner });
  const slug = markets.data?.find((candidate) => candidate.tokenId === order.tokenCategory)?.slug ?? null;
  const breadcrumb = breadcrumbFor(ownership, order, slug);
  const { heading, figure } = titleBlock(order);

  const [cancelOpen, setCancelOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLHeadingElement>(null);

  // Announce status changes once, never the status the page loaded with (order-detail.md labels).
  const [seenStatus, setSeenStatus] = useState(order.status);
  const [announcement, setAnnouncement] = useState('');
  if (seenStatus !== order.status) {
    setSeenStatus(order.status);
    setAnnouncement(`Order status: ${STATUS_DISPLAY[order.status].label}`);
  }

  const terminal = order.status === 'FILLED' || order.status === 'CANCELLED';
  const showCondition = order.status === 'OPEN' || order.status === 'FUNDING_PENDING';
  const spend = order.status === 'RECONCILIATION_REQUIRED' ? unexpectedSpend(order) : null;
  const shareUrl = typeof window === 'undefined' ? `/orders/${order.funding.txid}` : `${window.location.origin}/orders/${order.funding.txid}`;
  const owner = wallet.kind === 'connected' ? wallet : null;

  return (
    <div className={cn(PAGE, 'flex flex-col gap-6')}>
      <nav aria-label="Breadcrumb">
        <Link
          href={breadcrumb.href}
          className="inline-flex min-h-11 items-center gap-1 text-body-sm text-link underline-offset-4 hover:underline"
        >
          <CaretLeftIcon aria-hidden="true" className="size-4" />
          {breadcrumb.label}
        </Link>
        <span className="text-body-sm text-fg-muted">
          {' / Order '}
          <span className="hash text-mono-sm">{`${order.funding.txid.slice(0, 4)}…${order.funding.txid.slice(-4)}`}</span>
        </span>
      </nav>

      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="font-display text-heading-2 text-fg md:text-heading-1">{heading}</h1>
          {figure === null ? null : <p className="num text-num-xl text-fg [overflow-wrap:normal]">{figure}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <h2 ref={statusRef} tabIndex={-1} className="text-label text-fg-muted">
              Status
            </h2>
            <StatusBadge status={order.status} />
            <p role="status" className="sr-only">
              {announcement}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-body-sm text-fg-muted">Order</span>
            <HashChip value={order.funding.txid} kind="tx" label={`Order ${order.funding.txid}`} />
            {isOwner ? <span className="text-body-sm text-fg-secondary">This is your order</span> : null}
          </div>
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <div className="flex flex-wrap gap-3">
            <ShareButton url={shareUrl} />
            <CopyOrderIdButton txid={order.funding.txid} />
          </div>
          <CancelAction
            ownership={ownership}
            availability={availability}
            recoverHref={recoverHref(order.funding.txid)}
            networkMismatch={network.status === 'mismatch'}
            cancelRef={cancelRef}
            messageRef={messageRef}
            onCancel={() => setCancelOpen(true)}
          />
        </div>
      </header>

      {spend === null ? null : (
        <InlineAlert tone="warning" icon={GitDiffIcon} role="alert" title="Needs review">
          <p>{`AtPrice saw something it didn’t expect: ${spend.reason}. The chain is the source of truth.`}</p>
          {spend.txid === null ? null : <HashChip value={spend.txid} kind="tx" label={`Spending transaction ${spend.txid}`} />}
          <Link
            href={recoverHref(order.funding.txid)}
            className={cn(buttonVariants({ variant: 'outline', size: 'compact' }), 'mt-1 self-start')}
          >
            Check in Recover
          </Link>
        </InlineAlert>
      )}

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-6 lg:order-2">
          {terminal ? <TransactionReceipt order={order} /> : null}
          <section aria-labelledby="timeline-title" className="rounded-lg border border-border p-5 lg:p-6">
            <h2 id="timeline-title" className="mb-4 font-display text-heading-3 text-fg">
              Timeline
            </h2>
            <OrderTimeline steps={timelineSteps(order)} label="Order timeline" />
          </section>
          {showCondition ? (
            <div className="order-first lg:order-last">
              <ExecutionCondition
                order={order}
                spot={market.data?.spotRate.value ?? null}
                health={health.data}
              />
            </div>
          ) : null}
        </div>
        <div className="lg:order-1">
          <OrderTerms order={order} isOwner={isOwner} />
        </div>
      </div>

      <KeeperChecks order={order} />

      <p className="max-w-[64ch] text-body-sm text-fg-muted">{PRIVACY_NOTE}</p>

      {isOwner || cancelOpen ? (
        <CancelDialog
          open={cancelOpen}
          order={order}
          wallet={{
            owner: owner?.owner ?? null,
            walletName: owner?.wallet.name ?? null,
            reconnectingSince: owner?.reconnectingSince ?? null,
          }}
          onClosed={(changed) => {
            setCancelOpen(false);
            if (changed) void queryClient.invalidateQueries({ queryKey: queryKeys.orders() });
          }}
          returnFocusTo={(changed) => (changed ? statusRef.current : cancelRef.current ?? statusRef.current)}
        />
      ) : null}
    </div>
  );
}
