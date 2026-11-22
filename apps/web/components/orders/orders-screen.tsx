'use client';

import { useQuery } from '@tanstack/react-query';
import { GitDiffIcon, HourglassMediumIcon, ShieldWarningIcon, TrayIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, type RefObject } from 'react';
import { HashChip } from '@/components/hash-chip';
import { DisconnectedPanel, EmptyState, ErrorState, InlineAlert, LoadingRegion } from '@/components/states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConnectWalletButton } from '@/components/wallet/wallet-button';
import { isApiError } from '@/lib/api/errors';
import { queries, shouldRetry } from '@/lib/api/queries';
import type { Order, Ratio } from '@/lib/api/schemas';
import { truncateMiddle } from '@/lib/format';
import { appNetwork } from '@/lib/network';
import { walletNetworkLabel, type OwnerIdentity } from '@/lib/wallet/keys';
import { getWalletConnector, useWalletState } from '@/lib/wallet/store';
import { removeDraft, useStoredDraft, type UnfundedDraft } from './draft';
import {
  defaultTab,
  hasReconciliation,
  ORDER_TABS,
  parseTab,
  refreshIntervalFor,
  splitOrders,
  TAB_LABEL,
  type OrdersByTab,
  type OrderTab,
} from './order-lists';
import { OrderCards, OrdersTable } from './order-rows';
import { TxidLookup } from './txid-lookup';

const MISSING_RECEIVE =
  'Your wallet didn’t share the receive key path AtPrice uses to own orders, so AtPrice can’t find your orders. Look one up by its funding transaction id instead.';

const EMPTY: Readonly<Record<OrderTab, { readonly title: string; readonly body: string }>> = {
  open: { title: 'No open orders.', body: 'Orders you fund appear here while they wait for a fill.' },
  pending: {
    title: 'Nothing pending.',
    body: 'Funding, fills and cancels waiting for confirmation show here.',
  },
  history: { title: 'No filled or cancelled orders yet.', body: '' },
};

/** `bch-pusd` → `BCH/PUSD`, the draft's market as the notice names it. */
export const pairFromSlug = (slug: string): string =>
  slug
    .split('-')
    .map((part) => part.toUpperCase())
    .join('/');

/** My orders (orders.md). The page `<h1>` takes focus after connecting and after `Dismiss`. */
export function OrdersScreen() {
  const wallet = useWalletState();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const owner = wallet.kind === 'connected' ? wallet.owner : null;

  return (
    <div className="mx-auto flex w-full max-w-(--container-content) flex-col gap-6 px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h1 ref={headingRef} tabIndex={-1} className="font-display text-heading-2 text-fg md:text-heading-1">
          My orders
        </h1>
        {owner === null ? null : (
          <div className="flex items-center gap-2">
            <span className="text-body-sm text-fg-muted">Wallet</span>
            <HashChip value={owner.address} kind="address" label={`Wallet owner address ${owner.address}`} />
          </div>
        )}
      </div>
      <OrdersBody wallet={wallet} owner={owner} headingRef={headingRef} />
    </div>
  );
}

function OrdersBody({
  wallet,
  owner,
  headingRef,
}: {
  wallet: ReturnType<typeof useWalletState>;
  owner: OwnerIdentity | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  if (owner !== null) {
    return (
      <Suspense fallback={<OrdersLoading />}>
        <OwnerOrders owner={owner} headingRef={headingRef} />
      </Suspense>
    );
  }
  switch (wallet.kind) {
    case 'loading':
    case 'resuming':
      return <OrdersLoading />;
    case 'wrong_network':
      return (
        <InlineAlert tone="warning" icon={ShieldWarningIcon}>
          <p>{`Your wallet is on ${walletNetworkLabel(wallet.walletNetwork)}. Switch it to ${appNetwork.name} to see your orders here.`}</p>
        </InlineAlert>
      );
    case 'missing_receive':
      return (
        <div className="flex flex-col items-start gap-4 rounded-lg border border-border p-5 lg:p-6">
          <p className="max-w-[64ch] text-body text-fg-secondary">{MISSING_RECEIVE}</p>
          <TxidLookup />
          <Button
            variant="outline"
            onClick={() => {
              getWalletConnector()
                .disconnect()
                .catch((error: unknown) => console.error('Disconnect failed:', error));
            }}
          >
            Disconnect
          </Button>
        </div>
      );
    default:
      return (
        <div className="flex flex-col gap-4">
          <DisconnectedPanel
            thing="your orders"
            connectButton={<ConnectWalletButton fallback={() => headingRef.current} />}
          />
          <TxidLookup />
        </div>
      );
  }
}

function OrdersLoading() {
  return (
    <LoadingRegion thing="your orders" className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Skeleton className="h-11 w-24" />
        <Skeleton className="h-11 w-28" />
        <Skeleton className="h-11 w-28" />
      </div>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-32 w-full" />
      ))}
    </LoadingRegion>
  );
}

function DraftNotice({
  draft,
  headingRef,
}: {
  draft: UnfundedDraft;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div role="status" className="flex gap-3 rounded-md bg-status-pending-subtle p-4 text-body-sm text-fg">
      <HourglassMediumIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-status-pending" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <p>{`You reviewed a ${pairFromSlug(draft.slug)} order but didn’t fund it. Nothing was sent.`}</p>
          <Link
            href={`/trade/${draft.slug}?draft=${encodeURIComponent(draft.draftId)}`}
            className="self-start text-link underline underline-offset-4"
          >
            Review it again
          </Link>
        </div>
        <Button
          variant="outline"
          size="compact"
          className="self-start md:self-center"
          onClick={() => {
            removeDraft(draft);
            headingRef.current?.focus();
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function OwnerOrders({
  owner,
  headingRef,
}: {
  owner: OwnerIdentity;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = parseTab(searchParams.get('tab'));
  const draft = useStoredDraft();

  const orders = useQuery({
    ...queries.ordersByAddress(owner.address),
    refetchInterval: (query) =>
      refreshIntervalFor(
        defaultTab(requested, query.state.data === undefined ? null : splitOrders(query.state.data)),
      ),
    refetchOnWindowFocus: true,
    retry: shouldRetry,
  });
  const markets = useQuery({ ...queries.markets(), refetchInterval: 60_000 });
  const spotOf = (tokenCategory: string): Ratio | null =>
    markets.data?.find((market) => market.tokenId === tokenCategory)?.spotRate.value ?? null;

  const split: OrdersByTab | null = orders.data === undefined ? null : splitOrders(orders.data);
  const tab = defaultTab(requested, split);
  const draftFunded =
    draft !== null &&
    orders.data !== undefined &&
    orders.data.some((order) => order.contractAddress === draft.contractAddress);

  // sessionStorage is the external system: once the owner's list shows the draft's contract, the
  // signed transaction is the record and the draft pointer goes (funding-confirmation.md "Draft").
  useEffect(() => {
    if (draftFunded && draft !== null) removeDraft(draft);
  }, [draftFunded, draft]);

  const selectTab = (value: string) => {
    const next = parseTab(value);
    if (next === null) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-4">
      {draft !== null && !draftFunded ? <DraftNotice draft={draft} headingRef={headingRef} /> : null}
      <Tabs value={tab} onValueChange={selectTab} className="flex flex-col gap-4">
        <TabsList aria-label="Order lists" className="self-start">
          {ORDER_TABS.map((value) => {
            const count = split?.[value].length;
            const review = value === 'pending' && split !== null && hasReconciliation(split.pending);
            return (
              <TabsTrigger
                key={value}
                value={value}
                aria-label={
                  count === undefined
                    ? TAB_LABEL[value]
                    : `${TAB_LABEL[value]}, ${count} ${count === 1 ? 'order' : 'orders'}${review ? ', needs review' : ''}`
                }
              >
                {review ? <GitDiffIcon aria-hidden="true" className="size-4 text-status-review" /> : null}
                {TAB_LABEL[value]}
                {count === undefined ? (
                  <Skeleton className="h-4 w-4" />
                ) : (
                  <span className="num">{count}</span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {ORDER_TABS.map((value) => (
          <TabsContent
            key={value}
            value={value}
            tabIndex={split !== null && split[value].length === 0 ? 0 : -1}
          >
            <TabPanel
              tab={value}
              orders={split?.[value] ?? null}
              loading={orders.isPending}
              error={orders.isError && orders.data === undefined ? orders.error : null}
              retrying={orders.isFetching}
              onRetry={() => void orders.refetch()}
              owner={owner}
              spotOf={spotOf}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function TabPanel({
  tab,
  orders,
  loading,
  error,
  retrying,
  onRetry,
  owner,
  spotOf,
}: {
  tab: OrderTab;
  orders: readonly Order[] | null;
  loading: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  owner: OwnerIdentity;
  spotOf: (tokenCategory: string) => Ratio | null;
}) {
  if (error !== null) {
    return (
      <div className="flex flex-col gap-3">
        <ErrorState
          what="AtPrice can’t load your orders right now."
          code={isApiError(error) ? error.displayCode : 'API_UNREACHABLE'}
          stillWorks="Your funds stay in their contracts. To find and cancel them without AtPrice’s server, use Recover with your owner address."
          onRetry={onRetry}
          retrying={retrying}
        />
        <Link
          href={`/recover?address=${encodeURIComponent(owner.address)}`}
          className={buttonVariants({ variant: 'outline', className: 'self-start' })}
        >
          Recover an order
        </Link>
      </div>
    );
  }
  if (loading || orders === null) {
    return (
      <LoadingRegion thing="your orders" onRetry={onRetry} className="flex flex-col gap-3">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-32 w-full" />
        ))}
      </LoadingRegion>
    );
  }
  if (orders.length === 0) {
    return (
      <EmptyState
        icon={TrayIcon}
        title={EMPTY[tab].title}
        action={
          tab === 'open' ? (
            <Link href="/" className={buttonVariants({ variant: 'primary' })}>
              Place a limit order
            </Link>
          ) : undefined
        }
      >
        {EMPTY[tab].body}
      </EmptyState>
    );
  }
  const caption = `${TAB_LABEL[tab]} orders for wallet ${truncateMiddle(owner.address, 4, 2)}`;
  return (
    <>
      <div className="hidden lg:block">
        <OrdersTable orders={orders} tab={tab} caption={caption} spotOf={spotOf} />
      </div>
      <div className="lg:hidden">
        <OrderCards orders={orders} tab={tab} spotOf={spotOf} />
      </div>
    </>
  );
}
