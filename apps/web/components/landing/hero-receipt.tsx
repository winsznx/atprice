'use client';

import { ReceiptIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Num, Rate } from '@/components/amount';
import { orderOutputAsset, PairLogos, WithAssetLogo } from '@/components/token-logo';
import { ExplorerLink } from '@/components/explorer-link';
import { HashChip } from '@/components/hash-chip';
import { LocalTime } from '@/components/local-time';
import { EmptyState, ErrorState, LoadingRegion } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { buttonVariants, CONTROL_TRANSITION } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFailure } from '@/lib/api/errors';
import { formatBlockHeight } from '@/lib/format';
import { appNetwork } from '@/lib/network';
import { fillRate, limitText, marketOf, minimumText, receivedText, tokenSymbol } from '@/lib/orders/display';
import { cn } from '@/lib/utils';
import { orderTitle } from '@/components/evidence/evidence-logic';
import { aboveMinimumParts, latestFill, useProofEvidence, type FilledOrder } from './proof-data';

const CARD = 'flex flex-col gap-5 rounded-lg border border-border bg-surface p-(--space-panel) lg:p-(--space-panel-lg)';
const HEADING_ID = 'latest-fill';

function Row({ label, children, emphasis = false }: { label: string; children: ReactNode; emphasis?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
      <dt className="text-body-sm text-fg-muted">{label}</dt>
      <dd className={cn('min-w-0 text-right text-fg', emphasis ? 'text-num-lg' : 'text-num-md')}>{children}</dd>
    </div>
  );
}

const confirmationsText = (count: number): string =>
  count === 0 ? 'Not yet confirmed' : `${count.toLocaleString('en-US')} ${count === 1 ? 'confirmation' : 'confirmations'}`;

function Receipt({ order }: { order: FilledOrder }) {
  const fill = order.settlement;
  const above = aboveMinimumParts(order);
  const limit = limitText(order);
  const filledAt = fillRate(order, fill);
  const symbol = tokenSymbol(order.tokenCategory);
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={HEADING_ID} className="font-display text-heading-3 text-fg">
            {`Latest fill on ${appNetwork.name}`}
          </h2>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-fg-secondary">
            <PairLogos tokenCategory={order.tokenCategory} symbol={symbol} />
            {orderTitle(order)}
          </p>
          <p className="text-caption text-fg-muted">
            <LocalTime iso={order.settlementBlock.time} withDate />
          </p>
        </div>
        <StatusBadge status="FILLED" />
      </div>
      <dl className="flex flex-col divide-y divide-border border-y border-border">
        <Row label="Your minimum">
          <Num>{minimumText(order, 'exact')}</Num>
        </Row>
        <Row label="Delivered" emphasis>
          <WithAssetLogo asset={orderOutputAsset(order)} size={20}>
            <Num>{receivedText(order, fill.received, 'exact')}</Num>
          </WithAssetLogo>
        </Row>
        <Row label="Above your minimum">
          <Num className="text-status-filled">{above.percent === null ? above.amount : `${above.amount} (${above.percent})`}</Num>
        </Row>
        <Row label="Your limit">
          {limit === null ? <span className="text-fg-muted">Not available</span> : <Num>{limit}</Num>}
        </Row>
        <Row label="Filled at">
          {filledAt === null ? (
            <span className="text-fg-muted">Not available</span>
          ) : (
            <Rate
              numerator={filledAt.numerator}
              denominator={filledAt.denominator}
              unit={`${marketOf(order.tokenCategory)?.symbol ?? symbol} per BCH`}
              term
            />
          )}
        </Row>
      </dl>
      <dl className="flex flex-col gap-3 text-body-sm">
        <div className="flex flex-col gap-1">
          <dt className="text-fg-muted">Pool used</dt>
          <dd>
            <HashChip
              value={`${fill.poolOutpoint.txid}:${fill.poolOutpoint.vout}`}
              kind="outpoint"
              label={`Cauldron pool outpoint ${fill.poolOutpoint.txid}:${fill.poolOutpoint.vout}`}
            />
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-fg-muted">Settlement transaction</dt>
          <dd>
            <HashChip value={fill.txid} kind="tx" label={`Settlement transaction id ${fill.txid}`} />
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <div className="flex gap-2">
            <dt className="text-fg-muted">Network</dt>
            <dd className="text-fg">{appNetwork.name}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-fg-muted">Confirmations</dt>
            <dd className="num text-fg">
              {confirmationsText(fill.confirmations)}
              {fill.blockHeight === null ? null : `, block ${formatBlockHeight(fill.blockHeight)}`}
            </dd>
          </div>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-body-sm">
        <ExplorerLink kind="tx" value={fill.txid}>
          {`Open in the ${appNetwork.explorer.label}`}
        </ExplorerLink>
        <Link href="/evidence" className={cn('text-link underline underline-offset-4', CONTROL_TRANSITION)}>
          All fills and cancels
        </Link>
      </div>
    </>
  );
}

function ReceiptSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Skeleton className="h-16 w-3/4" />
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

/**
 * The hero's receipt: the newest real completed fill from `GET /evidence`, never an example. Its
 * loading, empty and error states say exactly what is and isn't known.
 */
export function HeroReceipt() {
  const evidence = useProofEvidence();
  if (evidence.data !== undefined) {
    const fill = latestFill(evidence.data.orders);
    if (fill === null) {
      return (
        <EmptyState
          icon={ReceiptIcon}
          title={`No fills recorded on ${appNetwork.name} yet`}
          className="bg-surface"
          action={
            <Link href="/trade" className={buttonVariants({ variant: 'outline' })}>
              Place a limit order
            </Link>
          }
        >
          When an AtPrice order fills, its receipt appears here with the pool, the amounts and the transaction.
        </EmptyState>
      );
    }
    return (
      <article aria-labelledby={HEADING_ID} className={CARD}>
        <Receipt order={fill} />
      </article>
    );
  }
  if (evidence.isError) {
    return (
      <div className={CARD}>
        <h2 className="font-display text-heading-3 text-fg">{`Latest fill on ${appNetwork.name}`}</h2>
        <ErrorState
          {...apiFailure(evidence.error, 'The latest fill can’t load.')}
          onRetry={() => void evidence.refetch()}
          retrying={evidence.isFetching}
        />
      </div>
    );
  }
  return (
    <div className={CARD}>
      <LoadingRegion thing="the latest fill" onRetry={() => void evidence.refetch()}>
        <ReceiptSkeleton />
      </LoadingRegion>
    </div>
  );
}
