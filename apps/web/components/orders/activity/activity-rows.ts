import type { Order, TransactionEvent } from '@/lib/api/schemas';
import { bchText, orderInputText, receivedText } from '@/lib/orders/display';
import { formatBlockHeight } from '@/lib/format';

/*
 * Activity (activity.md) as pure functions. Rows are transaction events of orders, so every row is a
 * chain observation the API already records in `transaction_events`; nothing is inferred here.
 */

export const ACTIVITY_SCOPES = ['mine', 'all', 'session'] as const;
export type ActivityScope = (typeof ACTIVITY_SCOPES)[number];

export const parseScope = (value: string | null): ActivityScope | null =>
  ACTIVITY_SCOPES.find((scope) => scope === value) ?? null;

export const KIND_FILTERS = ['all', 'funding', 'fill', 'cancel'] as const;
export type KindFilter = (typeof KIND_FILTERS)[number];

export const KIND_FILTER_LABEL: Readonly<Record<KindFilter, string>> = {
  all: 'All kinds',
  funding: 'Funding',
  fill: 'Fills',
  cancel: 'Cancels',
};

export const parseKind = (value: string | null): KindFilter =>
  KIND_FILTERS.find((kind) => kind === value) ?? 'all';

export type RowKind = 'funding' | 'fill' | 'cancel' | 'unknown';

export const KIND_LABEL: Readonly<Record<RowKind, string>> = {
  funding: 'Funding',
  fill: 'Fill',
  cancel: 'Cancel',
  unknown: 'Unexpected spend',
};

const KIND_OF: Readonly<Record<TransactionEvent['kind'], RowKind>> = {
  funding: 'funding',
  execute: 'fill',
  cancel: 'cancel',
  unknown_spend: 'unknown',
};

export interface ActivityRow {
  /** Unique per order and transaction: one transaction can touch only one order's events here. */
  readonly key: string;
  readonly txid: string;
  readonly kind: RowKind;
  readonly order: Order;
  readonly event: TransactionEvent;
}

/** Every transaction event of the given orders, newest first. */
export const activityRows = (orders: readonly Order[]): ActivityRow[] =>
  orders
    .flatMap((order) =>
      order.events.map(
        (event): ActivityRow => ({
          key: `${order.id}:${event.txid}:${event.kind}`,
          txid: event.txid,
          kind: KIND_OF[event.kind],
          order,
          event,
        }),
      ),
    )
    .sort((a, b) => b.event.firstSeenAt.localeCompare(a.event.firstSeenAt));

export const filterRows = (rows: readonly ActivityRow[], kind: KindFilter): readonly ActivityRow[] =>
  kind === 'all' ? rows : rows.filter((row) => row.kind === kind);

/** `0.05 BCH` for a funding; `0.05 BCH →` and the received amount for a fill; the refund for a cancel. */
export const amountParts = (row: ActivityRow): { readonly first: string; readonly second: string | null } => {
  const { order } = row;
  const input = orderInputText(order, 'compact');
  const settlement = order.settlement;
  if (row.kind === 'fill' && settlement?.kind === 'fill' && settlement.txid === row.txid) {
    return { first: `${input} →`, second: receivedText(order, settlement.received, 'compact') };
  }
  if (row.kind === 'cancel' && settlement?.kind === 'cancel' && settlement.txid === row.txid) {
    const bch = bchText(settlement.refundSats, 'compact');
    return order.side === 'sell' && settlement.refundTokens > 0n
      ? { first: `${orderInputText({ ...order, amount: settlement.refundTokens }, 'compact')} and`, second: `${bch} refunded` }
      : { first: `${bch} refunded`, second: null };
  }
  return { first: input, second: null };
};

export type StateTone = 'pending' | 'filled' | 'failed' | 'review';

export const STATE_DISPLAY: Readonly<
  Record<TransactionEvent['networkState'], { readonly label: string; readonly tone: StateTone }>
> = {
  seen: { label: 'Sent', tone: 'pending' },
  confirmed: { label: 'Confirmed', tone: 'filled' },
  conflicted: { label: 'Conflicted', tone: 'failed' },
  replaced: { label: 'Replaced', tone: 'review' },
};

/** The meta line under the state badge, and the spoken form that names attempt versus fact. */
export const stateText = (event: TransactionEvent): { readonly meta: string | null; readonly spoken: string } => {
  switch (event.networkState) {
    case 'seen':
      return { meta: 'not confirmed', spoken: 'Sent, not confirmed yet' };
    case 'confirmed':
      return event.blockHeight === null
        ? { meta: null, spoken: 'Confirmed' }
        : {
            meta: `block ${formatBlockHeight(event.blockHeight)}`,
            spoken: `Confirmed in block ${formatBlockHeight(event.blockHeight)}`,
          };
    case 'conflicted':
      return { meta: null, spoken: 'Conflicted' };
    case 'replaced':
      return { meta: null, spoken: 'Replaced' };
  }
};

const TXID = /^[0-9a-f]{64}$/;

/** `This transaction was replaced by {txid}` when the API names the replacement. */
export const replacement = (event: TransactionEvent): { readonly txid: string | null; readonly text: string | null } => {
  if (event.networkState !== 'conflicted' && event.networkState !== 'replaced') return { txid: null, text: null };
  if (event.conflict === null) return { txid: null, text: null };
  return TXID.test(event.conflict) ? { txid: event.conflict, text: null } : { txid: null, text: event.conflict };
};
