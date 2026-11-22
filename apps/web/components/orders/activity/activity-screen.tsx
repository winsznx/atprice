'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import {
  ArrowCounterClockwiseIcon,
  ArrowsLeftRightIcon,
  BellIcon,
  GitDiffIcon,
  HourglassMediumIcon,
  PaperPlaneTiltIcon,
  PlugsConnectedIcon,
  PlugsIcon,
  ProhibitInsetIcon,
  SealCheckIcon,
  ShieldWarningIcon,
  TrayIcon,
  WalletIcon,
  WarningIcon,
  WarningOctagonIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Num } from '@/components/amount';
import { HashChip } from '@/components/hash-chip';
import { LocalTime } from '@/components/local-time';
import {
  DisabledReason,
  DisconnectedPanel,
  EmptyState,
  ErrorState,
  InlineAlert,
  LoadingRegion,
} from '@/components/states';
import { ToneBadge } from '@/components/status-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConnectWalletButton } from '@/components/wallet/wallet-button';
import { isApiError } from '@/lib/api/errors';
import { queries, shouldRetry } from '@/lib/api/queries';
import type { Order } from '@/lib/api/schemas';
import { useNow } from '@/lib/hooks/use-now';
import { appNetwork } from '@/lib/network';
import { getNotificationCenter, useSessionNotifications } from '@/lib/notifications/store';
import type { NoticeIcon, RecordedNotification } from '@/lib/notifications/types';
import { walletNetworkLabel } from '@/lib/wallet/keys';
import { useWalletState } from '@/lib/wallet/store';
import { cn } from '@/lib/utils';
import { compactPair, formatShortDateTime, sideTitle } from '../order-lists';
import {
  activityRows,
  amountParts,
  filterRows,
  KIND_FILTER_LABEL,
  KIND_FILTERS,
  KIND_LABEL,
  parseKind,
  parseScope,
  replacement,
  STATE_DISPLAY,
  stateText,
  type ActivityRow,
  type ActivityScope,
  type KindFilter,
  type RowKind,
} from './activity-rows';

const PAGE =
  'mx-auto flex w-full max-w-(--container-content) flex-col gap-6 px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12';

const KIND_ICON: Readonly<Record<RowKind, PhosphorIcon>> = {
  funding: WalletIcon,
  fill: ArrowsLeftRightIcon,
  cancel: ArrowCounterClockwiseIcon,
  unknown: WarningIcon,
};

/** Kind badges are neutral (cancelled style) with their own icon (activity.md "Kind badges"). */
function KindBadge({ kind }: { kind: RowKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className="inline-flex min-h-6 items-center gap-1 rounded-full bg-status-cancelled-subtle px-2 text-caption font-semibold whitespace-nowrap text-status-cancelled">
      <Icon aria-hidden="true" className="size-4" />
      {KIND_LABEL[kind]}
    </span>
  );
}

function StateCell({ row }: { row: ActivityRow }) {
  const display = STATE_DISPLAY[row.event.networkState];
  const text = stateText(row.event);
  const replaced = replacement(row.event);
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="sr-only">{text.spoken}</span>
      <span aria-hidden="true" className="flex flex-col items-start gap-1">
        <ToneBadge tone={display.tone} label={display.label} />
        {text.meta === null ? null : <span className="num text-caption text-fg-muted">{text.meta}</span>}
      </span>
      {replaced.txid !== null ? (
        <span className="flex flex-col gap-1 text-caption text-fg-muted">
          This transaction was replaced by
          <HashChip value={replaced.txid} kind="tx" label={`Replacement transaction ${replaced.txid}`} />
        </span>
      ) : replaced.text !== null ? (
        <span className="text-caption text-fg-muted">{replaced.text}</span>
      ) : null}
    </span>
  );
}

function OrderLink({
  row,
  linkRef,
}: {
  row: ActivityRow;
  linkRef?: RefObject<HTMLAnchorElement | null> | undefined;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <Link
        ref={linkRef}
        href={`/orders/${row.order.funding.txid}`}
        className="text-body-sm text-link underline-offset-4 hover:underline"
      >
        {sideTitle(row.order)}
      </Link>
      <span className="text-caption text-fg-muted">{compactPair(row.order.tokenCategory)}</span>
    </span>
  );
}

function Amount({ row }: { row: ActivityRow }) {
  const parts = amountParts(row);
  return (
    <span className="flex flex-col">
      <Num size="sm">{parts.first}</Num>
      {parts.second === null ? null : <Num size="sm">{parts.second}</Num>}
    </span>
  );
}

function ActivityTable({
  rows,
  caption,
  firstNewIndex,
  firstNewRef,
}: {
  rows: readonly ActivityRow[];
  caption: string;
  firstNewIndex: number | null;
  firstNewRef: RefObject<HTMLAnchorElement | null>;
}) {
  const hydrated = useNow() !== null;
  return (
    <Table>
      <TableCaption>{caption}</TableCaption>
      <colgroup>
        <col style={{ width: '12.44%' }} />
        <col style={{ width: '12.44%' }} />
        <col style={{ width: '15.54%' }} />
        <col style={{ width: '17.62%' }} />
        <col style={{ width: '15.54%' }} />
        <col style={{ width: '26.42%' }} />
      </colgroup>
      <TableHeader>
        <TableRow className="h-10">
          <TableHead className="px-3">Time</TableHead>
          <TableHead className="px-3">Kind</TableHead>
          <TableHead className="px-3">Order</TableHead>
          <TableHead className="px-3">Amount</TableHead>
          <TableHead className="px-3">State</TableHead>
          <TableHead className="px-3">Transaction</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={row.key} className="h-auto">
            <TableCell className="num px-3 align-top text-num-sm">
              {formatShortDateTime(row.event.firstSeenAt, hydrated)}
            </TableCell>
            <TableCell className="px-3 align-top">
              <KindBadge kind={row.kind} />
            </TableCell>
            <TableCell className="px-3 align-top">
              <OrderLink row={row} linkRef={index === firstNewIndex ? firstNewRef : undefined} />
            </TableCell>
            <TableCell className="px-3 align-top">
              <Amount row={row} />
            </TableCell>
            <TableCell className="px-3 align-top">
              <StateCell row={row} />
            </TableCell>
            <TableCell className="px-3 align-top">
              <HashChip
                value={row.txid}
                kind="tx"
                label={`${KIND_LABEL[row.kind]} transaction ${row.txid}`}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ActivityCards({
  rows,
  firstNewIndex,
  firstNewRef,
}: {
  rows: readonly ActivityRow[];
  firstNewIndex: number | null;
  firstNewRef: RefObject<HTMLAnchorElement | null>;
}) {
  const hydrated = useNow() !== null;
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row, index) => (
        <li key={row.key} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <KindBadge kind={row.kind} />
            <span className="num text-num-sm text-fg-muted">
              {formatShortDateTime(row.event.firstSeenAt, hydrated)}
            </span>
            <span className="ml-auto">
              <StateCell row={row} />
            </span>
          </div>
          <OrderLink row={row} linkRef={index === firstNewIndex ? firstNewRef : undefined} />
          <Amount row={row} />
          <HashChip value={row.txid} kind="tx" label={`${KIND_LABEL[row.kind]} transaction ${row.txid}`} />
        </li>
      ))}
    </ul>
  );
}

function RowsLoading({ onRetry }: { onRetry?: () => void }) {
  return (
    <LoadingRegion
      thing="transactions"
      className="flex flex-col gap-3"
      {...(onRetry === undefined ? {} : { onRetry })}
    >
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-20 w-full" />
      ))}
    </LoadingRegion>
  );
}

function ListError({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <ErrorState
        what="AtPrice can’t load transactions right now."
        code={isApiError(error) ? error.displayCode : 'API_UNREACHABLE'}
        stillWorks="Your funds stay in their contracts. You can cancel any open order from Recover, which does not use AtPrice’s server."
        onRetry={onRetry}
        retrying={retrying}
      />
      <Link href="/recover" className={buttonVariants({ variant: 'outline', className: 'self-start' })}>
        Recover an order
      </Link>
    </div>
  );
}

function RowList({
  rows,
  caption,
  emptyTitle,
  emptyAction,
  firstNewIndex,
  firstNewRef,
}: {
  rows: readonly ActivityRow[];
  caption: string;
  emptyTitle: string;
  emptyAction?: ReactNode | undefined;
  firstNewIndex: number | null;
  firstNewRef: RefObject<HTMLAnchorElement | null>;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState icon={TrayIcon} title={emptyTitle} action={emptyAction}>
        {''}
      </EmptyState>
    );
  }
  return (
    <>
      <div className="hidden lg:block">
        <ActivityTable
          rows={rows}
          caption={caption}
          firstNewIndex={firstNewIndex}
          firstNewRef={firstNewRef}
        />
      </div>
      <div className="lg:hidden">
        <ActivityCards rows={rows} firstNewIndex={firstNewIndex} firstNewRef={firstNewRef} />
      </div>
    </>
  );
}

function MineList({
  kind,
  headingRef,
}: {
  kind: KindFilter;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const wallet = useWalletState();
  const owner = wallet.kind === 'connected' ? wallet.owner : null;
  const orders = useQuery({
    ...queries.ordersByAddress(owner?.address ?? ''),
    enabled: owner !== null,
    refetchInterval: 15_000,
    retry: shouldRetry,
  });
  const firstNewRef = useRef<HTMLAnchorElement>(null);

  if (owner === null) {
    switch (wallet.kind) {
      case 'loading':
      case 'resuming':
        return <RowsLoading />;
      case 'missing_receive':
        return (
          <InlineAlert tone="info">
            <p>
              Your wallet didn’t share the receive key path AtPrice uses to own orders, so AtPrice can’t list
              your transactions.
            </p>
          </InlineAlert>
        );
      case 'wrong_network':
        return (
          <InlineAlert tone="warning" icon={ShieldWarningIcon}>
            <p>{`Your wallet is on ${walletNetworkLabel(wallet.walletNetwork)}. Switch it to ${appNetwork.name} to see your transactions here.`}</p>
          </InlineAlert>
        );
      default:
        return (
          <DisconnectedPanel
            thing="your transactions"
            connectButton={<ConnectWalletButton fallback={() => headingRef.current} />}
          />
        );
    }
  }
  if (orders.isError && orders.data === undefined) {
    return (
      <ListError error={orders.error} onRetry={() => void orders.refetch()} retrying={orders.isFetching} />
    );
  }
  if (orders.data === undefined) return <RowsLoading onRetry={() => void orders.refetch()} />;
  return (
    <RowList
      rows={filterRows(activityRows(orders.data), kind)}
      caption="Your AtPrice transactions, newest first"
      emptyTitle={
        kind === 'all'
          ? 'No transactions from this wallet yet. Funding, fills and cancels of your orders appear here.'
          : `No ${KIND_FILTER_LABEL[kind].toLowerCase()} from this wallet yet.`
      }
      emptyAction={
        <Link href="/" className={buttonVariants({ variant: 'primary' })}>
          Place a limit order
        </Link>
      }
      firstNewIndex={null}
      firstNewRef={firstNewRef}
    />
  );
}

/**
 * All AtPrice transactions. The API in architecture.md r5 lists every order only through
 * `GET /evidence` (filled and cancelled orders), so this list says that it covers those orders.
 */
function AllList({ kind }: { kind: KindFilter }) {
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const pages = useQueries({
    queries: cursors.map((cursor, index) => ({
      ...queries.evidence(cursor),
      refetchInterval: index === 0 ? 30_000 : (false as const),
      retry: shouldRetry,
    })),
  });
  const firstNewRef = useRef<HTMLAnchorElement>(null);
  const [focusFrom, setFocusFrom] = useState<number | null>(null);

  const loaded = pages.filter((page) => page.data !== undefined);
  const orders: Order[] = loaded.flatMap((page) => page.data?.orders ?? []);
  const rows = filterRows(activityRows(orders), kind);
  const last = pages.at(-1);
  const nextCursor = last?.data?.nextCursor ?? null;
  const loadingMore = last !== undefined && last.isPending && cursors.length > 1;

  // Moving focus to the first new row is a DOM side effect of the newly rendered page.
  const firstNewIndex = focusFrom !== null && rows.length > focusFrom ? focusFrom : null;
  useEffect(() => {
    if (firstNewIndex !== null) firstNewRef.current?.focus();
  }, [firstNewIndex]);

  const first = pages[0];
  if (first?.isError && first.data === undefined) {
    return <ListError error={first.error} onRetry={() => void first.refetch()} retrying={first.isFetching} />;
  }
  if (first?.data === undefined) return <RowsLoading onRetry={() => void first?.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-sm text-fg-muted">{`Funding, fill and cancel transactions of filled and cancelled orders on ${appNetwork.name}.`}</p>
      <RowList
        rows={rows}
        caption={`All AtPrice transactions on ${appNetwork.name}, newest first`}
        emptyTitle={`No AtPrice transactions on ${appNetwork.name} yet.`}
        firstNewIndex={firstNewIndex}
        firstNewRef={firstNewRef}
      />
      {last?.isError ? (
        <ErrorState
          what="AtPrice couldn’t load older transactions."
          code={isApiError(last.error) ? last.error.displayCode : 'API_UNREACHABLE'}
          onRetry={() => void last.refetch()}
          retrying={last.isFetching}
        />
      ) : null}
      {nextCursor === null && !loadingMore ? null : (
        <Button
          variant="outline"
          className="self-start"
          aria-disabled={loadingMore || undefined}
          onClick={() => {
            if (nextCursor === null) return;
            setFocusFrom(rows.length);
            setCursors((current) => [...current, nextCursor]);
          }}
        >
          {loadingMore ? 'Loading older' : 'Load older'}
        </Button>
      )}
    </div>
  );
}

const NOTICE_ICON: Readonly<Record<NoticeIcon, { readonly icon: PhosphorIcon; readonly className: string }>> =
  {
    hourglass: { icon: HourglassMediumIcon, className: 'text-status-pending' },
    send: { icon: PaperPlaneTiltIcon, className: 'text-status-pending' },
    filled: { icon: SealCheckIcon, className: 'text-status-filled' },
    cancelled: { icon: ProhibitInsetIcon, className: 'text-status-cancelled' },
    failed: { icon: WarningOctagonIcon, className: 'text-status-failed' },
    review: { icon: GitDiffIcon, className: 'text-status-review' },
    link: { icon: PlugsConnectedIcon, className: 'text-fg-secondary' },
    unlink: { icon: PlugsIcon, className: 'text-fg-secondary' },
  };

const DELIVERY: Readonly<Record<RecordedNotification['delivery'], string>> = {
  raised: 'Shown as a notification',
  dialog: 'Shown in its dialog',
  queued: 'Held until a dialog closed',
};

function SessionList({ entries }: { entries: readonly RecordedNotification[] }) {
  if (entries.length === 0) {
    return (
      <EmptyState icon={BellIcon} title="No notifications in this session yet.">
        {''}
      </EmptyState>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {entries.map((entry) => {
        const { icon: Icon, className } = NOTICE_ICON[entry.icon];
        return (
          <li key={entry.id} className="flex min-w-0 gap-3 rounded-md border border-border p-4">
            <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', className)} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-label font-semibold text-fg">{entry.title}</p>
                <span className="text-caption text-fg-muted">
                  <LocalTime iso={new Date(entry.createdAt).toISOString()} />
                </span>
              </div>
              <p className="num text-body-sm text-fg-secondary">{entry.body}</p>
              <p className="text-caption text-fg-muted">
                {entry.meta === null
                  ? DELIVERY[entry.delivery]
                  : `${entry.meta} · ${DELIVERY[entry.delivery]}`}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {entry.txid === null ? null : <HashChip value={entry.txid} kind="tx" />}
                {entry.actions.map((action) => (
                  <Link
                    key={action.label}
                    href={action.href}
                    className="text-body-sm text-link underline underline-offset-4"
                  >
                    {action.label}
                  </Link>
                ))}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** activity.md `Clear session list`: stays focusable when empty, with the reason, so focus isn't lost. */
export function ClearSessionButton({ empty }: { empty: boolean }) {
  const reasonId = useId();
  return (
    <div className="flex flex-col items-start gap-1 md:items-end">
      <Button
        variant="outline"
        aria-disabled={empty || undefined}
        aria-describedby={empty ? reasonId : undefined}
        onClick={() => getNotificationCenter().clear()}
      >
        Clear session list
      </Button>
      {empty ? <DisabledReason id={reasonId}>Nothing to clear.</DisabledReason> : null}
    </div>
  );
}

/** Activity (activity.md): the wallet's transactions, all AtPrice transactions, and this session's notifications. */
export function ActivityScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const wallet = useWalletState();
  const entries = useSessionNotifications();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const connected = wallet.kind === 'connected';
  const scope: ActivityScope = parseScope(searchParams.get('scope')) ?? (connected ? 'mine' : 'all');
  const kind = parseKind(searchParams.get('kind'));

  const setParam = (key: 'scope' | 'kind', value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (key === 'kind' && value === 'all') params.delete('kind');
    else params.set(key, value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onScope = (value: string) => {
    const next = parseScope(value);
    if (next !== null) setParam('scope', next);
  };

  return (
    <div className={PAGE}>
      <h1 ref={headingRef} tabIndex={-1} className="font-display text-heading-2 text-fg md:text-heading-1">
        Activity
      </h1>
      <Tabs value={scope} onValueChange={onScope} className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <TabsList aria-label="Activity lists" className="self-start">
            <TabsTrigger value="mine">My transactions</TabsTrigger>
            <TabsTrigger value="all">All AtPrice</TabsTrigger>
            <TabsTrigger
              value="session"
              aria-label={`This session, ${entries.length} ${entries.length === 1 ? 'notification' : 'notifications'}`}
            >
              This session
              <span className="num">{entries.length}</span>
            </TabsTrigger>
          </TabsList>
          {scope === 'session' ? (
            <ClearSessionButton empty={entries.length === 0} />
          ) : (
            <label className="flex items-center gap-2 text-body-sm text-fg-secondary">
              Filter
              <Select value={kind} onValueChange={(value) => setParam('kind', value)}>
                <SelectTrigger aria-label="Filter by kind" className="min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_FILTERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {KIND_FILTER_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
        </div>
        <TabsContent value="mine">
          <MineList kind={kind} headingRef={headingRef} />
        </TabsContent>
        <TabsContent value="all">
          <AllList kind={kind} />
        </TabsContent>
        <TabsContent value="session" tabIndex={entries.length === 0 ? 0 : -1}>
          <SessionList entries={entries} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
