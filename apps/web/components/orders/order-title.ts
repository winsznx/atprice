import { SELL_ORDER_SATS } from '@atprice/core';
import type { Order } from '@/lib/api/schemas';
import { bchText, limitText, orderInputText, receivedText, tokenSymbol } from '@/lib/orders/display';

/*
 * The order page's title block and link-preview text (order-detail.md "Route", "Title block"). Kept
 * free of client modules so the server page can render metadata with it.
 */

const TXID = /^[0-9a-f]{64}$/;

/** `/orders/[id]` takes the funding txid (64 hex); anything else is a 404 with the spec's sentence. */
export const isOrderId = (id: string): boolean => TXID.test(id);

export interface TitleBlock {
  readonly heading: string;
  /** Figure line under the `<h1>`, DD 4 compact, with units. Null when the limit can't be derived. */
  readonly figure: string | null;
}

/** The `<h1>` (words only) and the figure line, per order-detail.md "Title block". */
export const titleBlock = (order: Order): TitleBlock => {
  const symbol = tokenSymbol(order.tokenCategory);
  const settlement = order.settlement;
  if (order.status === 'FILLED' && settlement?.kind === 'fill') {
    if (order.side === 'buy') {
      return {
        heading: `Bought ${symbol}`,
        figure: `${receivedText(order, settlement.received, 'compact')} for ${orderInputText(order, 'compact')}`,
      };
    }
    const proceeds = settlement.received - SELL_ORDER_SATS;
    return {
      heading: `Sold ${symbol}`,
      figure: `${bchText(proceeds > 0n ? proceeds : 0n, 'compact')} for ${orderInputText(order, 'compact')}`,
    };
  }
  if (order.status === 'CANCELLED' && settlement?.kind === 'cancel') {
    const bch = bchText(settlement.refundSats, 'compact');
    return {
      heading: 'Cancelled order',
      figure:
        order.side === 'sell' && settlement.refundTokens > 0n
          ? `${orderInputText({ ...order, amount: settlement.refundTokens }, 'compact')} and ${bch} refunded`
          : `${bch} refunded`,
    };
  }
  const limit = limitText(order);
  return {
    heading: `${order.side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`,
    figure: limit === null ? null : `Limit ${limit}`,
  };
};

/** `Buy PUSD at 460.00 PUSD per BCH`: the share card's title. No addresses. */
export const orderHeadline = (order: Order): string => {
  const symbol = tokenSymbol(order.tokenCategory);
  const limit = limitText(order);
  const verb = order.side === 'buy' ? 'Buy' : 'Sell';
  return limit === null ? `${verb} ${symbol}` : `${verb} ${symbol} at ${limit}`;
};

/** Open Graph title: `Buy PUSD at 460.00 PUSD per BCH on AtPrice`. No addresses. */
export const openGraphTitle = (order: Order): string => `${orderHeadline(order)} on AtPrice`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `Funded 22 Nov 2026.` (UTC date: metadata and share cards are rendered on the server). */
export const fundedText = (order: Order): string => {
  const funding = order.events.find((event) => event.kind === 'funding');
  const date = new Date(funding?.firstSeenAt ?? order.createdAt);
  return `Funded ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}.`;
};

/** `Status: Open. Funded 22 Nov 2026.` */
export const openGraphDescription = (order: Order, statusLabel: string): string =>
  `Status: ${statusLabel}. ${fundedText(order)}`;
