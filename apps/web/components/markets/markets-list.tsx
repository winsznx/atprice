'use client';

import { ArrowDownIcon, ArrowUpIcon, ArrowsDownUpIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MouseEvent } from 'react';
import { HashChip } from '@/components/hash-chip';
import { PairLogos, type TokenLogoSize } from '@/components/token-logo';
import { CONTROL_TRANSITION } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { MarketSummary } from '@/lib/api/schemas';
import { formatBch, shortUnits } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AvailabilityBadge, AvailabilityReason, ChangeValue, SpotRate, VolumeValue } from './market-bits';
import {
  availabilityOf,
  liquidityExact,
  marketPath,
  shortSymbol,
  sortCaption,
  type MarketSort,
  type SortKey,
} from './market-logic';

/** `BCH / ` may break after the slash, never inside the symbol (markets.md "Table columns"). */
function PairName({
  tokenId,
  symbol,
  logoSize,
}: {
  tokenId: string;
  symbol: string;
  logoSize: TokenLogoSize;
}) {
  return (
    <>
      <PairLogos tokenCategory={tokenId} symbol={symbol} size={logoSize} className="mr-1.5 align-middle" />
      BCH /<wbr /> {shortSymbol(symbol)}
      {symbol.length > shortSymbol(symbol).length ? <span className="sr-only">{`, full symbol ${symbol}`}</span> : null}
    </>
  );
}

function Liquidity({ market }: { market: MarketSummary }) {
  return (
    <span className="num">
      <span aria-hidden="true">
        {`${shortUnits(market.liquidity.tokens, market.decimals)} ${shortSymbol(market.symbol)} ·`}
        <br />
        {`${formatBch(market.liquidity.sats, 'compact')} BCH`}
      </span>
      <span className="sr-only">{liquidityExact(market)}</span>
    </span>
  );
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: MarketSort;
  onSort: (key: SortKey) => void;
  className?: string | undefined;
}) {
  const active = sort.key === column;
  const Icon = !active ? ArrowsDownUpIcon : sort.dir === 'asc' ? ArrowUpIcon : ArrowDownIcon;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('px-3', className)}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex min-h-(--size-control-sm) items-center gap-1 rounded-sm text-left uppercase hover:text-fg',
          active ? 'text-fg' : undefined,
          CONTROL_TRANSITION,
        )}
      >
        {label}
        <Icon aria-hidden="true" className="size-4 shrink-0" />
      </button>
    </TableHead>
  );
}

const COLUMNS = (
  <colgroup>
    <col className="w-[200px]" />
    <col className="w-[136px]" />
    <col className="w-[128px]" />
    <col className="w-[144px]" />
    <col className="w-[128px]" />
    <col className="w-[160px]" />
  </colgroup>
);

/** Forwards a click anywhere on the row to its one real link, so the row has one tab stop (DD 7.6). */
const useRowLink = () => {
  const router = useRouter();
  return (event: MouseEvent<HTMLElement>, href: string) => {
    const target = event.target as HTMLElement;
    if (target.closest('a, button') !== null) return;
    if (window.getSelection()?.toString() !== '') return;
    router.push(href);
  };
};

/** DD 7.6 market table, from lg, at the widths in markets.md (898px of 960px at 1024). */
export function MarketsTable({
  markets,
  sort,
  onSort,
  networkMismatch,
}: {
  markets: readonly MarketSummary[];
  sort: MarketSort;
  onSort: (key: SortKey) => void;
  networkMismatch: boolean;
}) {
  const onRowClick = useRowLink();
  return (
    <Table>
      <TableCaption>{sortCaption(sort)}</TableCaption>
      {COLUMNS}
      <TableHeader>
        <tr>
          <SortHeader label="Pair" column="pair" sort={sort} onSort={onSort} />
          <TableHead className="px-3 text-right">Rate (per BCH)</TableHead>
          <SortHeader label="24h change" column="change" sort={sort} onSort={onSort} className="text-right" />
          <SortHeader label="Liquidity" column="liquidity" sort={sort} onSort={onSort} className="text-right" />
          <TableHead className="px-3 text-right">24h volume</TableHead>
          <TableHead className="px-3">Availability</TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {markets.map((market) => {
          const availability = availabilityOf(market, networkMismatch);
          const href = marketPath(market.slug);
          return (
            <TableRow
              key={market.tokenId}
              onClick={(event) => onRowClick(event, href)}
              className={cn('cursor-pointer align-top hover:bg-surface-sunken', CONTROL_TRANSITION)}
            >
              <TableCell className="px-3">
                <div className="flex flex-col items-start gap-1">
                  <Link
                    href={href}
                    className={cn('text-num-sm font-semibold text-fg underline-offset-4 hover:underline', CONTROL_TRANSITION)}
                  >
                    <PairName tokenId={market.tokenId} symbol={market.symbol} logoSize={16} />
                  </Link>
                  <HashChip
                    value={market.tokenId}
                    kind="token"
                    label={`${market.symbol} token category ${market.tokenId}`}
                    className="max-w-full"
                  />
                </div>
              </TableCell>
              <TableCell className="px-3 text-right text-num-sm">
                <SpotRate market={market} />
              </TableCell>
              <TableCell className="px-3 text-right text-num-sm">
                <ChangeValue change={market.change24h} />
              </TableCell>
              <TableCell className="px-3 text-right text-num-sm">
                <Liquidity market={market} />
              </TableCell>
              <TableCell className="px-3 text-right text-num-sm">
                <VolumeValue market={market} />
              </TableCell>
              <TableCell className="px-3">
                <div className="flex flex-col items-start gap-1">
                  <AvailabilityBadge display={availability} />
                  {availability.reason === null || availability.availability !== 'paused' ? null : (
                    <span className="text-body-sm text-fg-muted">{availability.reason}</span>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Below lg: one card per market, each one link to its detail page (markets.md "390 x 844"). */
export function MarketCards({
  markets,
  networkMismatch,
}: {
  markets: readonly MarketSummary[];
  networkMismatch: boolean;
}) {
  const onCardClick = useRowLink();
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
      {markets.map((market) => {
        const availability = availabilityOf(market, networkMismatch);
        const href = marketPath(market.slug);
        return (
          <li
            key={market.tokenId}
            onClick={(event) => onCardClick(event, href)}
            className={cn(
              'flex min-w-0 cursor-pointer flex-col gap-3 rounded-lg border border-border p-(--space-panel) hover:bg-surface-sunken',
              CONTROL_TRANSITION,
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link
                href={href}
                className={cn('text-num-md font-semibold text-fg underline-offset-4 hover:underline', CONTROL_TRANSITION)}
              >
                <PairName tokenId={market.tokenId} symbol={market.symbol} logoSize={20} />
              </Link>
              <AvailabilityBadge display={availability} />
            </div>
            <AvailabilityReason display={availability} />
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-num-sm text-fg">
              <SpotRate market={market} />
              <ChangeValue change={market.change24h} />
            </p>
            <p className="text-body-sm text-fg-secondary">
              Liquidity{' '}
              <span className="num text-fg">
                <span aria-hidden="true">{`${shortUnits(market.liquidity.tokens, market.decimals)} ${shortSymbol(market.symbol)}`}</span>
                <span className="sr-only">{liquidityExact(market)}</span>
              </span>
            </p>
            <HashChip value={market.tokenId} kind="token" label={`${market.symbol} token category ${market.tokenId}`} />
          </li>
        );
      })}
    </ul>
  );
}

const SKELETON_ROWS = [0, 1, 2, 3] as const;

export function MarketsTableSkeleton() {
  return (
    <Table>
      <TableCaption>Markets on AtPrice, loading</TableCaption>
      {COLUMNS}
      <TableHeader>
        <tr>
          {['Pair', 'Rate (per BCH)', '24h change', 'Liquidity', '24h volume', 'Availability'].map((label) => (
            <TableHead key={label} className="px-3">
              {label}
            </TableHead>
          ))}
        </tr>
      </TableHeader>
      <TableBody>
        {SKELETON_ROWS.map((row) => (
          <TableRow key={row} className="h-[88px]">
            {[0, 1, 2, 3, 4, 5].map((cell) => (
              <TableCell key={cell} className="px-3">
                <Skeleton className="h-5 w-full" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function MarketCardsSkeleton() {
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
      {SKELETON_ROWS.map((row) => (
        <li key={row} className="flex flex-col gap-3 rounded-lg border border-border p-(--space-panel)">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-8 w-[197px] max-w-full" />
        </li>
      ))}
    </ul>
  );
}
