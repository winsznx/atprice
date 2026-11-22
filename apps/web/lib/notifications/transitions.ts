import type { OrderStatus } from '@atprice/core';
import type { Order } from '../api/schemas';
import {
  cancelRaceLost,
  confirmationLost,
  fillSent,
  fundingConfirmedAndActive,
  orderActive,
  orderCancelled,
  orderFilled,
  orderNeedsReview,
} from './messages';
import type { AppNotification } from './types';

/**
 * The messages a polled status change raises (notifications.md #5 to #10, #11c, #13, #14). `previous`
 * is the last status this browser saw for the order, or undefined when it has never seen it.
 * `CANCELLATION_PENDING` raises nothing here: `Cancel sent` (#9) belongs to the cancel dialog.
 */
export const messagesForStatusChange = (
  previous: OrderStatus | undefined,
  order: Order,
  context: { readonly cancelSentHere: boolean },
): AppNotification[] => {
  const next = order.status;
  if (previous === next) return [];
  switch (next) {
    case 'FUNDING_PENDING':
    case 'CANCELLATION_PENDING':
      return [];
    case 'OPEN':
      if (previous === 'EXECUTION_PENDING' || previous === 'CANCELLATION_PENDING') return [];
      if (previous === 'FUNDING_PENDING' || previous === undefined) return [fundingConfirmedAndActive(order)];
      return [orderActive(order)];
    case 'EXECUTION_PENDING':
      if (previous === 'CANCELLATION_PENDING' && context.cancelSentHere) return [cancelRaceLost(order)];
      return [fillSent(order)];
    case 'FILLED':
      if (previous === 'CANCELLATION_PENDING' && context.cancelSentHere) return [cancelRaceLost(order)];
      return [orderFilled(order)];
    case 'CANCELLED':
      return [orderCancelled(order)];
    case 'RECONCILIATION_REQUIRED':
      if (previous === 'FILLED') return [confirmationLost(order, 'fill')];
      if (previous === 'CANCELLED') return [confirmationLost(order, 'cancel')];
      return [orderNeedsReview(order)];
  }
};
