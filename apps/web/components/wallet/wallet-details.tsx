'use client';

import { SUPPORTED_MARKETS, BUY_PAYOUT_SATS, SELL_ORDER_SATS } from '@atprice/core';
import { useQuery } from '@tanstack/react-query';
import { CaretDownIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { isApiError } from '@/lib/api/errors';
import { queries } from '@/lib/api/queries';
import type { Order } from '@/lib/api/schemas';
import { chainErrorCode, isChainError } from '@/lib/chain/types';
import { getChain } from '@/lib/chain/client';
import { formatBch, formatToken } from '@/lib/format';
import { appNetwork } from '@/lib/network';
import type { OwnerIdentity } from '@/lib/wallet/keys';
import type { WalletIdentity } from '@/lib/wallet/connector';
import { useWalletScan } from '@/lib/wallet/store';
import { cn } from '@/lib/utils';
import { HashChip } from '../hash-chip';
import { ErrorState } from '../states';
import { ToneBadge } from '../status-badge';
import { BchLogo, TokenLogo } from '../token-logo';
import { buttonVariants, CONTROL_TRANSITION } from '../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Skeleton } from '../ui/skeleton';

const LOCKED: readonly Order['status'][] = [
  'OPEN',
  'FUNDING_PENDING',
  'EXECUTION_PENDING',
  'CANCELLATION_PENDING',
  'RECONCILIATION_REQUIRED',
];

/** `You lock` per order (DD 7.4): buy `spend + 1,000 + maxNetworkFee`, sell 2,000 sat plus the tokens. */
const lockedTotals = (orders: readonly Order[]): { sats: bigint; tokens: Map<string, bigint> } => {
  let sats = 0n;
  const tokens = new Map<string, bigint>();
  for (const order of orders) {
    if (!LOCKED.includes(order.status)) continue;
    if (order.side === 'buy') {
      sats += order.amount + BUY_PAYOUT_SATS + order.maxNetworkFee;
    } else {
      sats += SELL_ORDER_SATS;
      tokens.set(order.tokenCategory, (tokens.get(order.tokenCategory) ?? 0n) + order.amount);
    }
  }
  return { sats, tokens };
};

function BalanceRow({ label, value, spoken }: { label: ReactNode; value: string; spoken: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2" aria-label={spoken} role="group">
      <span className="flex min-w-0 items-center gap-2 text-body-sm text-fg">{label}</span>
      <span className="num text-num-md text-fg">{value}</span>
    </div>
  );
}

/** Wallet icon only from a `data:` URI: a remote URL would be a third-party request (CSP `img-src`). */
export function WalletIcon({ wallet }: { wallet: WalletIdentity }) {
  if (wallet.icon === null || !wallet.icon.startsWith('data:image/')) return null;
  // eslint-disable-next-line @next/next/no-img-element -- a data: URI from wallet_ready; next/image adds nothing here
  return <img src={wallet.icon} alt="" width={24} height={24} className="size-6 rounded-xs" />;
}

/** The panel body for a connected wallet (wallet.md "Wallet panel" wireframe). */
export function WalletDetails({ wallet, owner }: { wallet: WalletIdentity; owner: OwnerIdentity }) {
  const scan = useWalletScan(owner);
  const orders = useQuery({ ...queries.ordersByAddress(owner.address), refetchInterval: 30_000 });
  const [othersOpen, setOthersOpen] = useState(false);
  const markets = SUPPORTED_MARKETS[appNetwork.network];

  const supported = new Set(markets.map((market) => market.tokenCategory));
  const others = scan.data?.tokens.filter((token) => !supported.has(token.category)) ?? [];
  const locked = orders.data === undefined ? null : lockedTotals(orders.data);
  const empty = scan.data !== undefined && scan.data.utxos.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <ToneBadge tone="filled" label="Connected" />
        <WalletIcon wallet={wallet} />
        <span className="text-label text-fg">{wallet.name}</span>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-label text-fg">Owner address (used for your orders)</p>
        <HashChip value={owner.address} kind="address" />
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-label text-fg">Network</span>
        <span className="text-body-sm text-fg-secondary capitalize">{appNetwork.name}</span>
      </div>

      <section
        aria-labelledby="wallet-balances"
        aria-busy={scan.isPending || undefined}
        className="flex flex-col"
      >
        <h3 id="wallet-balances" className="text-label font-semibold text-fg">
          {scan.data === undefined ? (
            'Balances'
          ) : (
            <>
              Balances (coins at <span className="num">{scan.data.addressesWithCoins}</span>{' '}
              {scan.data.addressesWithCoins === 1 ? 'address' : 'addresses'})
            </>
          )}
        </h3>
        {scan.isPending ? (
          <div className="mt-2 flex flex-col gap-2">
            <p role="status" className="sr-only">
              Loading balances
            </p>
            {[0, 1].map((row) => (
              <div key={row} className="flex items-center justify-between py-2">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-6 w-28" />
              </div>
            ))}
          </div>
        ) : scan.isError ? (
          <ErrorState
            className="mt-2"
            what={`Couldn't read balances from ${getChain().endpointLabel ?? 'any Electrum server'}.`}
            code={isChainError(scan.error) ? chainErrorCode(scan.error) : 'ELECTRUM_UNREACHABLE'}
            stillWorks="Orders are disabled with the reason Balance unknown, so the order can't be built."
            onRetry={() => void scan.refetch()}
            retrying={scan.isFetching}
          />
        ) : empty ? (
          <div className="mt-2 flex flex-col gap-2 text-body-sm text-fg-secondary">
            <p>{`This wallet has no BCH on ${appNetwork.name} at the addresses AtPrice can see.`}</p>
            {appNetwork.faucet === null ? null : (
              <a
                href={appNetwork.faucet.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link underline underline-offset-4"
              >
                {appNetwork.faucet.label}
                <span className="sr-only">, opens in a new tab</span>
              </a>
            )}
          </div>
        ) : (
          <div className="mt-1 flex flex-col divide-y divide-border">
            <BalanceRow
              label={
                <>
                  <BchLogo />
                  <span>BCH</span>
                </>
              }
              value={`${formatBch(scan.data.bchSats, 'compact')} BCH`}
              spoken={`BCH, ${formatBch(scan.data.bchSats, 'compact')} BCH`}
            />
            {markets.map((market) => {
              const units =
                scan.data.tokens.find((token) => token.category === market.tokenCategory)?.fungible ?? 0n;
              const text = `${formatToken(units, market.decimals, 'compact')} ${market.symbol}`;
              return (
                <BalanceRow
                  key={market.tokenCategory}
                  label={
                    <>
                      <TokenLogo asset={market.tokenCategory} symbol={market.symbol} />
                      <span>{market.symbol}</span>
                      <HashChip value={market.tokenCategory} kind="token" />
                    </>
                  }
                  value={text}
                  spoken={`${market.symbol}, category ${market.tokenCategory.slice(0, 6)}…${market.tokenCategory.slice(-4)}, ${text}`}
                />
              );
            })}
            {others.length === 0 ? null : (
              <Collapsible open={othersOpen} onOpenChange={setOthersOpen}>
                <CollapsibleTrigger
                  className={cn(
                    'flex min-h-(--size-control) w-full items-center justify-between text-body-sm text-fg',
                    CONTROL_TRANSITION,
                  )}
                >
                  <span>
                    Other tokens (<span className="num">{others.length}</span>)
                  </span>
                  <CaretDownIcon aria-hidden="true" className={cn('size-4', othersOpen && 'rotate-180')} />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="flex flex-col gap-2 pb-2">
                    {others.map((token) => (
                      <li
                        key={token.category}
                        className="flex flex-wrap items-center gap-2 text-body-sm text-fg-muted"
                      >
                        <HashChip value={token.category} kind="token" />
                        Not traded on AtPrice
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}
      </section>

      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <span className="text-label text-fg">Locked in open orders</span>
          {locked === null ? (
            orders.isError ? (
              <span className="text-body-sm text-fg-muted">
                Not available (
                <span className="hash">
                  {isApiError(orders.error) ? orders.error.displayCode : 'API_UNREACHABLE'}
                </span>
                )
              </span>
            ) : (
              <Skeleton className="h-6 w-28" />
            )
          ) : (
            <span className="flex flex-col items-end">
              <span className="num text-num-md text-fg">{`${formatBch(locked.sats, 'compact')} BCH`}</span>
              {[...locked.tokens.entries()].map(([category, units]) => {
                const market = markets.find((entry) => entry.tokenCategory === category);
                return market === undefined ? null : (
                  <span
                    key={category}
                    className="num text-num-md text-fg"
                  >{`${formatToken(units, market.decimals, 'compact')} ${market.symbol}`}</span>
                );
              })}
            </span>
          )}
        </div>
        <Link href="/orders" className={cn(buttonVariants({ variant: 'link' }), 'self-start')}>
          View my orders
        </Link>
      </div>
    </div>
  );
}
