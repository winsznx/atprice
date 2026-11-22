import { BUY_PAYOUT_SATS, SELL_ORDER_SATS } from '@atprice/core';
import type { ReactNode } from 'react';
import { Num } from '@/components/amount';
import { HashChip } from '@/components/hash-chip';
import { SideBadge } from '@/components/status-badge';
import type { Order } from '@/lib/api/schemas';
import { formatFee, formatSats } from '@/lib/format';
import {
  bchText,
  displayMinimum,
  limitText,
  minimumText,
  orderInputText,
  pairLabel,
  tokenSymbol,
} from '@/lib/orders/display';

function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border py-3 last:border-0 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-body-sm text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-body-sm text-fg">{children}</dd>
    </div>
  );
}

/** `You locked`: the funding output value, with its parts in BCH in the same (exact) mode. */
function Locked({ order }: { order: Order }) {
  if (order.side === 'buy') {
    const total = order.amount + order.maxNetworkFee + BUY_PAYOUT_SATS;
    return (
      <span className="flex flex-col gap-1">
        <Num size="md">{bchText(total, 'exact')}</Num>
        <span className="flex flex-col text-fg-muted">
          <Num>{`${bchText(order.amount, 'exact')} order`}</Num>
          <Num>{`+ ${bchText(order.maxNetworkFee, 'exact')} fee cap`}</Num>
          <Num>{`+ ${bchText(BUY_PAYOUT_SATS, 'exact')} dust`}</Num>
        </span>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <Num size="md">{orderInputText(order, 'exact')}</Num>
      <Num className="text-fg-muted">{`+ ${bchText(SELL_ORDER_SATS, 'exact')} reserve`}</Num>
    </span>
  );
}

function Receive({ order }: { order: Order }) {
  const minimum = displayMinimum(order);
  if (minimum.kind === 'none') return <span>{minimumText(order, 'exact')}</span>;
  return (
    <span className="flex flex-col gap-1">
      <Num size="md">{`at least ${minimumText(order, 'exact')}`}</Num>
      {minimum.kind === 'sats' ? (
        <span className="text-fg-muted">
          Paid in one output of at least <Num>{bchText(minimum.sats + SELL_ORDER_SATS, 'exact')}</Num>: your
          proceeds plus the {formatSats(SELL_ORDER_SATS)} sat reserve you locked. The network fee comes out of
          the pool’s BCH, not out of this.
        </span>
      ) : null}
    </span>
  );
}

/** Order detail `Terms` (order-detail.md "Copy"): a `<dl>`, every amount in DD 4 `exact` mode. */
export function OrderTerms({ order, isOwner }: { order: Order; isOwner: boolean }) {
  const limit = limitText(order);
  return (
    <section aria-labelledby="terms-title" className="rounded-lg border border-border p-5 lg:p-6">
      <h2 id="terms-title" className="font-display text-heading-3 text-fg">
        Terms
      </h2>
      {order.supported ? null : (
        <p className="mt-2 text-body-sm text-fg-secondary">
          {`Not supported by AtPrice, cancel only${order.unsupportedReason === null ? '' : ` (${order.unsupportedReason})`}.`}
        </p>
      )}
      <dl className="mt-2">
        <Term label="Pair">
          <span className="flex flex-col items-start gap-1">
            <span>{pairLabel(order.tokenCategory)}</span>
            <HashChip
              value={order.tokenCategory}
              kind="token"
              label={`${tokenSymbol(order.tokenCategory)} token category ${order.tokenCategory}`}
            />
          </span>
        </Term>
        <Term label="Side">
          <span className="inline-flex items-center gap-2">
            <SideBadge side={order.side} />
            {`${order.side === 'buy' ? 'Buy' : 'Sell'} ${tokenSymbol(order.tokenCategory)}`}
          </span>
        </Term>
        <Term label="You locked">
          <Locked order={order} />
        </Term>
        <Term label="Limit price">
          {limit === null ? (
            <span className="text-fg-muted">Not available</span>
          ) : (
            <Num size="md">{limit}</Num>
          )}
        </Term>
        <Term label="You receive">
          <Receive order={order} />
        </Term>
        {isOwner ? (
          <Term label="Paid to">
            <HashChip
              value={order.recipientAddress}
              kind="address"
              label={`Paid to ${order.recipientAddress}`}
            />
          </Term>
        ) : null}
        <Term label="Network fee cap">
          <Num size="md">{formatFee(order.maxNetworkFee)}</Num>
        </Term>
        <Term label="Contract">
          <span className="flex flex-wrap items-center gap-2">
            <HashChip
              value={order.contractAddress}
              kind="address"
              label={`Contract ${order.contractAddress}`}
            />
            <span className="num text-fg-muted">{`v${order.contractVersion}`}</span>
          </span>
        </Term>
        <Term label="Funding output">
          <HashChip
            value={`${order.funding.txid}:${order.funding.vout}`}
            kind="outpoint"
            label={`Funding output ${order.funding.txid}:${order.funding.vout}`}
          />
        </Term>
      </dl>
    </section>
  );
}
