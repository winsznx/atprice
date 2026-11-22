import type { OrderStatus } from '@atprice/core';
import type { Order, Ratio } from '@/lib/api/schemas';
import { formatPercent } from '@/lib/format';
import {
  bchText,
  displayMinimum,
  limitText,
  orderInputText,
  receivedText,
  tokenSymbol,
} from '@/lib/orders/display';
import { STATUS_DISPLAY } from '@/components/status-badge';

/*
 * My orders (orders.md) as pure functions: tab membership, the default tab, row ordering and the
 * sub-lines each row shows. The screen renders what these return and never re-derives a rule.
 */

export const ORDER_TABS = ['open', 'pending', 'history'] as const;
export type OrderTab = (typeof ORDER_TABS)[number];

export const TAB_LABEL: Readonly<Record<OrderTab, string>> = {
  open: 'Open',
  pending: 'Pending',
  history: 'History',
};

const TAB_OF: Readonly<Record<OrderStatus, OrderTab>> = {
  OPEN: 'open',
  FUNDING_PENDING: 'pending',
  EXECUTION_PENDING: 'pending',
  CANCELLATION_PENDING: 'pending',
  RECONCILIATION_REQUIRED: 'pending',
  FILLED: 'history',
  CANCELLED: 'history',
};

export const tabOf = (status: OrderStatus): OrderTab => TAB_OF[status];

export const parseTab = (value: string | null): OrderTab | null =>
  ORDER_TABS.find((tab) => tab === value) ?? null;

export type OrdersByTab = Readonly<Record<OrderTab, readonly Order[]>>;

const byNewest = (a: Order, b: Order): number => b.createdAt.localeCompare(a.createdAt);

/** Splits the owner's orders into tabs, newest first; `RECONCILIATION_REQUIRED` is pinned to the top of Pending. */
export const splitOrders = (orders: readonly Order[]): OrdersByTab => {
  const open: Order[] = [];
  const pending: Order[] = [];
  const history: Order[] = [];
  for (const order of orders) {
    const tab = tabOf(order.status);
    (tab === 'open' ? open : tab === 'pending' ? pending : history).push(order);
  }
  pending.sort((a, b) => {
    const reviewA = a.status === 'RECONCILIATION_REQUIRED' ? 0 : 1;
    const reviewB = b.status === 'RECONCILIATION_REQUIRED' ? 0 : 1;
    return reviewA - reviewB || byNewest(a, b);
  });
  return { open: open.sort(byNewest), pending, history: history.sort(byNewest) };
};

/** `?tab=` wins; otherwise Open, or Pending when Open is empty and Pending is not (orders.md "Route"). */
export const defaultTab = (requested: OrderTab | null, split: OrdersByTab | null): OrderTab => {
  if (requested !== null) return requested;
  if (split !== null && split.open.length === 0 && split.pending.length > 0) return 'pending';
  return 'open';
};

/** Refresh per orders.md "Data sources": 15 s on Open, 5 s on Pending, on load and focus for History. */
export const refreshIntervalFor = (tab: OrderTab): number | false =>
  tab === 'open' ? 15_000 : tab === 'pending' ? 5_000 : false;

export const hasReconciliation = (orders: readonly Order[]): boolean =>
  orders.some((order) => order.status === 'RECONCILIATION_REQUIRED');

const TXID = /^[0-9a-f]{64}$/;

/** A pasted txid may arrive in upper case or with surrounding spaces; anything else is not a txid. */
export const normalizeTxid = (input: string): string | null => {
  const value = input.trim().toLowerCase();
  return TXID.test(value) ? value : null;
};

/** The fill or cancel transaction, from the settlement or, before the API decodes it, the events. */
export const settlementTxid = (order: Pick<Order, 'settlement' | 'events'>): string | null =>
  order.settlement?.txid ??
  [...order.events]
    .reverse()
    .find(
      (event) =>
        (event.kind === 'execute' || event.kind === 'cancel') &&
        event.networkState !== 'conflicted' &&
        event.networkState !== 'replaced',
    )?.txid ??
  null;

/** `min 230.00 PUSD`, or for a sell the proceeds with `(proceeds)` (DD 4.1, compact). */
export const minimumLine = (order: Order): string => {
  const minimum = displayMinimum(order);
  if (minimum.kind === 'none') return 'No minimum price';
  const text = `min ${receivedText(order, minimum.kind === 'tokens' ? minimum.units : minimum.sats, 'compact')}`;
  return order.side === 'sell' ? `${text} (proceeds)` : text;
};

/**
 * How far the rate now is from the order's limit, as a share of the rate now, in tokens per BCH.
 * Positive: the market still has to move by that much. Zero or negative: the spot rate already
 * reaches the limit (the keeper's quote for the full size is what decides a fill).
 */
export const distanceToLimit = (
  order: Pick<Order, 'side' | 'amount' | 'minOut'>,
  spot: Ratio,
): { readonly numerator: bigint; readonly denominator: bigint } | null => {
  const minimum = displayMinimum(order);
  if (minimum.kind === 'none' || spot.numerator === 0n) return null;
  // spot is sats per token unit (n/d); the rate now in tokens per sat is d/n.
  const n = spot.numerator;
  const d = spot.denominator;
  if (minimum.kind === 'tokens') {
    // Buy limit in tokens per sat is minOut/amount; short = (minOut/amount − d/n) / (d/n).
    return { numerator: minimum.units * n - order.amount * d, denominator: order.amount * d };
  }
  // Sell limit in tokens per sat is amount/P; short = (d/n − amount/P) / (d/n).
  return { numerator: d * minimum.sats - order.amount * n, denominator: d * minimum.sats };
};

/** `2.31% from the rate now`, or null when the spot rate already reaches the limit or is unknown. */
export const distanceLine = (order: Order, spot: Ratio | null): string | null => {
  if (spot === null) return null;
  const distance = distanceToLimit(order, spot);
  if (distance === null || distance.numerator <= 0n) return null;
  return `${formatPercent(distance.numerator, distance.denominator)} from the rate now`;
};

/** History sub-line: `Received {x} {SYM}` (filled) or `Refunded {x}` (cancelled), compact. */
export const outcomeLine = (order: Order): string | null => {
  const settlement = order.settlement;
  if (settlement === null) return null;
  if (settlement.kind === 'fill') return `Received ${receivedText(order, settlement.received, 'compact')}`;
  const bch = bchText(settlement.refundSats, 'compact');
  if (order.side === 'sell' && settlement.refundTokens > 0n) {
    return `Refunded ${orderInputText({ ...order, amount: settlement.refundTokens }, 'compact')} and ${bch}`;
  }
  return `Refunded ${bch}`;
};

/** `Buy PUSD`, `Sell PUSD`. */
export const sideTitle = (order: Pick<Order, 'side' | 'tokenCategory'>): string =>
  `${order.side === 'buy' ? 'Buy' : 'Sell'} ${tokenSymbol(order.tokenCategory)}`;

/** `BCH/PUSD` without spaces, as the list shows it. */
export const compactPair = (tokenCategory: string): string => `BCH/${tokenSymbol(tokenCategory)}`;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const pad = (value: number): string => value.toString().padStart(2, '0');

/** `22 Nov 13:40` (or `22 November 13:40` spoken), local time once hydrated, UTC before. */
export const formatShortDateTime = (iso: string, local: boolean, spoken = false): string => {
  const date = new Date(iso);
  const day = local ? date.getDate() : date.getUTCDate();
  const month = MONTHS[local ? date.getMonth() : date.getUTCMonth()] ?? '';
  const hours = local ? date.getHours() : date.getUTCHours();
  const minutes = local ? date.getMinutes() : date.getUTCMinutes();
  return `${day} ${spoken ? month : month.slice(0, 3)} ${pad(hours)}:${pad(minutes)}${local ? '' : ' UTC'}`;
};

/**
 * Row link name (orders.md "Screen-reader labels"):
 * `Buy PUSD on BCH/PUSD, 0.50 BCH, limit 460.00 PUSD per BCH, Open, created 22 November 13:40`.
 */
export const orderRowName = (order: Order, local: boolean): string => {
  const limit = limitText(order);
  return [
    `${sideTitle(order)} on ${compactPair(order.tokenCategory)}`,
    orderInputText(order, 'compact'),
    limit === null ? 'no limit price' : `limit ${limit.replace('≈ ', 'about ')}`,
    STATUS_DISPLAY[order.status].label,
    `created ${formatShortDateTime(order.createdAt, local, true)}`,
  ].join(', ');
};
