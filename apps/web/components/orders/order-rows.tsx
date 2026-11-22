'use client';

import Link from 'next/link';
import { Num } from '@/components/amount';
import { HashChip } from '@/components/hash-chip';
import { LocalTime } from '@/components/local-time';
import { SideBadge, StatusBadge } from '@/components/status-badge';
import { orderInputAsset, PairLogos, WithAssetLogo } from '@/components/token-logo';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Order, Ratio } from '@/lib/api/schemas';
import { truncateMiddle } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { limitText, orderInputText, tokenSymbol } from '@/lib/orders/display';
import { cn } from '@/lib/utils';
import {
  compactPair,
  distanceLine,
  formatShortDateTime,
  minimumLine,
  orderRowName,
  outcomeLine,
  settlementTxid,
  sideTitle,
  type OrderTab,
} from './order-lists';

const REVIEW_LINE = 'AtPrice saw an unexpected spend. Open the order for details.';

/** DD 7.15: symbols over 12 characters are truncated, the full one stays in the accessible name. */
const shortPair = (tokenCategory: string): string => {
  const symbol = tokenSymbol(tokenCategory);
  return symbol.length > 12 ? `BCH/${symbol.slice(0, 11)}…` : compactPair(tokenCategory);
};

function TxChip({ role, txid }: { role: 'Funding' | 'Settlement'; txid: string | null }) {
  if (txid === null) {
    return (
      <span aria-label={`${role}: none yet`} className="text-body-sm text-fg-muted">
        None yet
      </span>
    );
  }
  return (
    <HashChip
      value={txid}
      kind="tx"
      label={`${role} transaction ${txid}`}
      copyLabel={`${role} transaction ${truncateMiddle(txid)}, copy`}
    />
  );
}

function LimitCell({ order, tab, spot }: { order: Order; tab: OrderTab; spot: Ratio | null }) {
  const limit = limitText(order);
  const subLine =
    order.status === 'RECONCILIATION_REQUIRED'
      ? REVIEW_LINE
      : tab === 'open'
        ? distanceLine(order, spot)
        : tab === 'history'
          ? outcomeLine(order)
          : null;
  return (
    <span className="flex flex-col gap-1">
      {limit === null ? <span className="text-fg-muted">Not available</span> : <Num size="sm">{limit}</Num>}
      {subLine === null ? null : <span className="num text-caption text-fg-muted">{subLine}</span>}
    </span>
  );
}

function StatusCell({ order }: { order: Order }) {
  return (
    <span className="flex flex-col items-start gap-1">
      <StatusBadge status={order.status} />
      {order.status === 'OPEN' && order.keeperCheck !== null ? (
        <span className="text-caption text-fg-muted">
          Last check <LocalTime iso={order.keeperCheck.checkedAt} />
        </span>
      ) : null}
    </span>
  );
}

/** The table from lg (orders.md "Table columns and widths"): fixed layout, six columns. */
export function OrdersTable({
  orders,
  tab,
  caption,
  spotOf,
}: {
  orders: readonly Order[];
  tab: OrderTab;
  caption: string;
  spotOf: (tokenCategory: string) => Ratio | null;
}) {
  const hydrated = useNow() !== null;
  return (
    <Table>
      <TableCaption>{caption}</TableCaption>
      <colgroup>
        <col style={{ width: '12.06%' }} />
        <col style={{ width: '9.05%' }} />
        <col style={{ width: '18.09%' }} />
        <col style={{ width: '15.08%' }} />
        <col style={{ width: '20.10%' }} />
        <col style={{ width: '25.62%' }} />
      </colgroup>
      <TableHeader>
        <TableRow className="h-10">
          <TableHead className="px-3">Pair</TableHead>
          <TableHead className="px-3">Side</TableHead>
          <TableHead className="px-3">Amount</TableHead>
          <TableHead className="px-3">Limit (per BCH)</TableHead>
          <TableHead className="px-3">Status</TableHead>
          <TableHead className="px-3">Transactions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.id} className="h-auto align-top">
            <TableCell className="px-3 align-top">
              <span className="flex flex-col gap-1">
                <Link
                  href={`/orders/${order.funding.txid}`}
                  aria-label={orderRowName(order, hydrated)}
                  className="num text-num-sm text-link underline-offset-4 hover:underline"
                >
                  <PairLogos
                    tokenCategory={order.tokenCategory}
                    symbol={tokenSymbol(order.tokenCategory)}
                    className="mr-1.5 align-middle"
                  />
                  {shortPair(order.tokenCategory)}
                </Link>
                <span className="num text-caption text-fg-muted">
                  {`Created ${formatShortDateTime(order.createdAt, hydrated)}`}
                </span>
              </span>
            </TableCell>
            <TableCell className="px-3 align-top">
              <SideBadge side={order.side} />
            </TableCell>
            <TableCell className="px-3 align-top">
              <span className="flex flex-col gap-1">
                <WithAssetLogo asset={orderInputAsset(order)}>
                  <Num size="sm">{orderInputText(order, 'compact')}</Num>
                </WithAssetLogo>
                <span className="num text-caption text-fg-muted">{minimumLine(order)}</span>
              </span>
            </TableCell>
            <TableCell className="px-3 align-top">
              <LimitCell order={order} tab={tab} spot={spotOf(order.tokenCategory)} />
            </TableCell>
            <TableCell className="px-3 align-top">
              <StatusCell order={order} />
            </TableCell>
            <TableCell className="px-3 align-top">
              <span className="flex min-w-0 flex-col items-start gap-1">
                <span className="text-caption text-fg-muted">Funding</span>
                <TxChip role="Funding" txid={order.funding.txid} />
                <span className="text-caption text-fg-muted">Settlement</span>
                <TxChip role="Settlement" txid={settlementTxid(order)} />
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Below lg each order is a card; the title row is the link, chips are separate tab stops. */
export function OrderCards({
  orders,
  tab,
  spotOf,
}: {
  orders: readonly Order[];
  tab: OrderTab;
  spotOf: (tokenCategory: string) => Ratio | null;
}) {
  const hydrated = useNow() !== null;
  return (
    <ul className="flex flex-col gap-3">
      {orders.map((order) => {
        const limit = limitText(order);
        const outcome = tab === 'history' ? outcomeLine(order) : null;
        const distance = tab === 'open' ? distanceLine(order, spotOf(order.tokenCategory)) : null;
        return (
          <li key={order.id} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-4">
            <Link
              href={`/orders/${order.funding.txid}`}
              aria-label={orderRowName(order, hydrated)}
              className="flex flex-wrap items-center gap-2 rounded-sm"
            >
              <SideBadge side={order.side} />
              <span className="sr-only">{sideTitle(order)}</span>
              <span className="inline-flex items-center gap-1.5">
                <PairLogos tokenCategory={order.tokenCategory} symbol={tokenSymbol(order.tokenCategory)} />
                <span className="num text-num-sm text-link">{shortPair(order.tokenCategory)}</span>
              </span>
              <StatusBadge status={order.status} className="ml-auto" />
            </Link>
            <p className="num text-num-sm text-fg">
              {`${orderInputText(order, 'compact')} → at least `}
              <span className="whitespace-nowrap">{minimumLine(order).replace(/^min /, '')}</span>
            </p>
            {order.status === 'RECONCILIATION_REQUIRED' ? (
              <p className="text-body-sm text-fg-secondary">{REVIEW_LINE}</p>
            ) : null}
            {outcome === null ? null : <p className="num text-body-sm text-fg">{outcome}</p>}
            <dl className="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2 text-body-sm">
              <dt className="text-fg-muted">Limit</dt>
              <dd className="num min-w-0">
                {limit === null ? 'Not available' : `${limit}`}
                {distance === null ? null : (
                  <span className="block text-caption text-fg-muted">{distance}</span>
                )}
              </dd>
              <dt className="text-fg-muted">Created</dt>
              <dd className="num">{formatShortDateTime(order.createdAt, hydrated)}</dd>
              <dt className="text-fg-muted">Funding</dt>
              <dd className={cn('min-w-0')}>
                <TxChip role="Funding" txid={order.funding.txid} />
              </dd>
              <dt className="text-fg-muted">Settlement</dt>
              <dd className="min-w-0">
                <TxChip role="Settlement" txid={settlementTxid(order)} />
              </dd>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
