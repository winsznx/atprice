import type { Order } from '../api/schemas';
import { truncateMiddle } from '../format';
import { appNetwork } from '../network';
import { bchText, limitText, orderInputText, pairLabel, receivedText } from '../orders/display';
import type { AppNotification, MessageFlow, NoticeAction } from './types';

/*
 * Every message of notifications.md (PRD 7.7's eleven plus the honest-failure additions), with its
 * exact copy, kind, duration and flow. Attempt messages never use a check icon or the words
 * confirmed, complete or done; chain events always carry the block height; failures always say what
 * was or wasn't spent.
 */

const ATTEMPT_MS = 6_000;
const CHAIN_MS = 10_000;
const SESSION_MS = 4_000;
const NOT_CONFIRMED = 'Not confirmed yet';

const blockMeta = (height: number | null): string =>
  height === null ? NOT_CONFIRMED : `Confirmed in block ${height.toLocaleString('en-US')}`;

const viewOrder = (order: Pick<Order, 'funding'>): NoticeAction => ({
  label: 'View order',
  href: `/orders/${order.funding.txid}`,
});
const viewReceipt = (order: Pick<Order, 'funding'>): NoticeAction => ({
  label: 'View receipt',
  href: `/orders/${order.funding.txid}#receipt`,
});
const openInRecover = (): NoticeAction => ({ label: 'Open in Recover', href: '/recover' });

const base = (
  fields: Omit<AppNotification, 'createdAt' | 'meta' | 'txid' | 'address' | 'actions' | 'flow'> &
    Partial<Pick<AppNotification, 'meta' | 'txid' | 'address' | 'actions' | 'flow'>>,
): AppNotification => ({
  meta: null,
  txid: null,
  address: null,
  actions: [],
  flow: null,
  ...fields,
  createdAt: Date.now(),
});

const fundingHeight = (order: Order): number | null =>
  order.events.find((event) => event.kind === 'funding')?.blockHeight ?? null;

const limitOf = (order: Order): string => limitText(order) ?? 'your minimum';

// 1, 2: wallet session

export const walletConnected = (input: {
  walletName: string;
  address: string;
  sessionId: string;
}): AppNotification =>
  base({
    id: `${input.sessionId}:connected`,
    ref: '1',
    kind: 'session',
    icon: 'link',
    title: 'Wallet connected',
    body: `${input.walletName}, ${truncateMiddle(input.address)} on ${appNetwork.name}`,
    address: input.address,
    durationMs: SESSION_MS,
    flow: { kind: 'connect', subject: null },
  });

export const walletDisconnected = (input: {
  sessionId: string;
  byUser: boolean;
  reason: string | null;
  message: string | null;
}): AppNotification =>
  base({
    id: `${input.sessionId}:disconnected`,
    ref: '2',
    kind: 'session',
    icon: 'unlink',
    title: 'Wallet disconnected',
    body: input.byUser
      ? 'Your open orders are unaffected.'
      : `${input.message ?? input.reason ?? 'The wallet ended the session'}. Your open orders are unaffected.`,
    meta: input.byUser ? null : input.reason,
    durationMs: SESSION_MS,
    // A disconnect with the connect modal open is that modal's state (notifications.md "Flow ownership").
    flow: { kind: 'connect', subject: null },
  });

// 3, 4: funding attempt

export const fundingAwaitingSignature = (draftId: string): AppNotification =>
  base({
    id: `${draftId}:awaiting-signature`,
    ref: '3',
    kind: 'attempt',
    icon: 'hourglass',
    title: 'Waiting for your wallet',
    body: 'Approve the funding transaction in your wallet. Nothing is sent until you approve.',
    meta: NOT_CONFIRMED,
    durationMs: ATTEMPT_MS,
    flow: { kind: 'funding', subject: draftId },
  });

/** Row 3 for the cancel flow: the cancel dialog's `Waiting for your wallet` state (notifications.md). */
export const cancelAwaitingSignature = (orderId: string, requestId: string): AppNotification =>
  base({
    id: `${requestId}:awaiting-signature`,
    ref: '3',
    kind: 'attempt',
    icon: 'hourglass',
    title: 'Waiting for your wallet',
    body: 'Approve the cancel in your wallet. Nothing is sent until you approve.',
    meta: NOT_CONFIRMED,
    durationMs: ATTEMPT_MS,
    flow: { kind: 'cancel', subject: orderId },
  });

export const fundingSent = (input: { draftId: string; txid: string; amountText: string }): AppNotification =>
  base({
    id: `${input.txid}:funding-sent`,
    ref: '4',
    kind: 'attempt',
    icon: 'send',
    title: 'Funding sent',
    body: `${input.amountText} is on its way to your order contract.`,
    meta: NOT_CONFIRMED,
    txid: input.txid,
    actions: [{ label: 'View order', href: `/orders/${input.txid}` }],
    durationMs: ATTEMPT_MS,
    flow: { kind: 'funding', subject: input.draftId },
  });

// 5 to 10, 13, 14: order status changes observed by polling

export const fundingConfirmed = (order: Order): AppNotification =>
  base({
    id: `${order.id}:FUNDING_CONFIRMED`,
    ref: '5',
    kind: 'chain',
    icon: 'filled',
    title: 'Funding confirmed',
    body: `${pairLabel(order.tokenCategory)} order, ${orderInputText(order, 'compact')}.`,
    meta: blockMeta(fundingHeight(order)),
    txid: order.funding.txid,
    durationMs: CHAIN_MS,
  });

export const orderActive = (order: Order): AppNotification =>
  base({
    id: `${order.id}:OPEN`,
    ref: '6',
    kind: 'chain',
    icon: 'filled',
    title: 'Order active',
    body: `Watching pools for your limit of ${limitOf(order)}. Anyone can fill it once a pool pays your minimum.`,
    actions: [viewOrder(order)],
    durationMs: CHAIN_MS,
  });

export const fundingConfirmedAndActive = (order: Order): AppNotification => {
  const height = fundingHeight(order);
  return base({
    id: `${order.id}:OPEN`,
    ref: '5+6',
    kind: 'chain',
    icon: 'filled',
    title: 'Order active',
    body: `Funding confirmed in block ${height === null ? 'unknown' : height.toLocaleString('en-US')}. Watching pools for your limit of ${limitOf(order)}.`,
    meta: blockMeta(height),
    txid: order.funding.txid,
    actions: [viewOrder(order)],
    durationMs: CHAIN_MS,
  });
};

export const fillSent = (order: Order): AppNotification =>
  base({
    id: `${order.id}:EXECUTION_PENDING`,
    ref: '7',
    kind: 'attempt',
    icon: 'send',
    title: 'Fill sent',
    body: `A fill was sent for your ${pairLabel(order.tokenCategory)} order. Waiting for confirmation.`,
    meta: NOT_CONFIRMED,
    txid: order.events.find((event) => event.kind === 'execute')?.txid ?? null,
    durationMs: ATTEMPT_MS,
  });

export const orderFilled = (order: Order): AppNotification => {
  const fill = order.settlement?.kind === 'fill' ? order.settlement : null;
  return base({
    id: `${order.id}:FILLED`,
    ref: '8',
    kind: 'chain',
    icon: 'filled',
    title: 'Order filled',
    body:
      fill === null
        ? `Your ${pairLabel(order.tokenCategory)} order filled.`
        : `You received ${receivedText(order, fill.received, 'compact')} for ${orderInputText(order, 'compact')}.`,
    meta: blockMeta(fill?.blockHeight ?? null),
    txid: fill?.txid ?? null,
    actions: [viewReceipt(order)],
    durationMs: CHAIN_MS,
  });
};

export const cancelSent = (input: { orderId: string; txid: string; refundText: string }): AppNotification =>
  base({
    id: `${input.txid}:cancel-sent`,
    ref: '9',
    kind: 'attempt',
    icon: 'send',
    title: 'Cancel sent',
    body: `Your refund of ${input.refundText} is on its way.`,
    meta: NOT_CONFIRMED,
    txid: input.txid,
    durationMs: ATTEMPT_MS,
    flow: { kind: 'cancel', subject: input.orderId },
  });

const refundText = (order: Order): string => {
  const cancel = order.settlement?.kind === 'cancel' ? order.settlement : null;
  if (cancel === null) return orderInputText(order, 'compact');
  if (order.side === 'sell' && cancel.refundTokens > 0n) {
    return `${orderInputText({ ...order, amount: cancel.refundTokens }, 'compact')} and ${bchText(cancel.refundSats, 'compact')}`;
  }
  return bchText(cancel.refundSats, 'compact');
};

export const orderCancelled = (order: Order): AppNotification => {
  const cancel = order.settlement?.kind === 'cancel' ? order.settlement : null;
  return base({
    id: `${order.id}:CANCELLED`,
    ref: '10',
    kind: 'chain',
    icon: 'cancelled',
    title: 'Order cancelled',
    body: `${refundText(order)} refunded to your wallet.`,
    meta: blockMeta(cancel?.blockHeight ?? null),
    txid: cancel?.txid ?? null,
    durationMs: CHAIN_MS,
  });
};

export const orderNeedsReview = (order: Order): AppNotification =>
  base({
    id: `${order.id}:RECONCILIATION_REQUIRED`,
    ref: '13',
    kind: 'failure',
    icon: 'review',
    title: 'Order needs review',
    body: `AtPrice saw an unexpected transaction for your ${pairLabel(order.tokenCategory)} order.`,
    actions: [viewOrder(order)],
    durationMs: null,
  });

export const confirmationLost = (order: Order, lost: 'fill' | 'cancel'): AppNotification =>
  base({
    id: `${order.id}:CONFIRMATION_LOST:${lost}`,
    ref: '14',
    kind: 'failure',
    icon: 'review',
    title: 'Confirmation lost',
    body: `The block with your ${lost} was replaced. AtPrice is checking the chain again.`,
    actions: [viewOrder(order)],
    durationMs: null,
  });

// 11a to 11d, 12, 15: failures

type FlowName = 'funding' | 'cancel';
const flowTitle = (flow: FlowName, funding: string, cancel: string): string =>
  flow === 'funding' ? funding : cancel;

export const signDeclined = (flow: MessageFlow & { kind: FlowName }, requestId: string): AppNotification =>
  base({
    id: `${requestId}:declined`,
    ref: '11a',
    kind: 'failure',
    icon: 'failed',
    title: flowTitle(flow.kind, 'Funding declined', 'Cancel declined'),
    body: 'You declined it in your wallet. Nothing was sent.',
    durationMs: null,
    flow,
  });

export const broadcastRejected = (
  flow: MessageFlow & { kind: FlowName },
  requestId: string,
  nodeMessage: string,
  retry: (() => void) | null,
): AppNotification =>
  base({
    id: `${requestId}:rejected`,
    ref: '11b',
    kind: 'failure',
    icon: 'failed',
    title: flowTitle(flow.kind, 'Funding failed', 'Cancel failed'),
    body: `The network rejected the transaction: ${nodeMessage}. Nothing was spent.`,
    actions: retry === null ? [] : [{ label: 'Try again', run: retry }],
    durationMs: null,
    flow,
  });

export const cancelRaceLost = (order: Order): AppNotification => {
  const fill = order.settlement?.kind === 'fill' ? order.settlement : null;
  return base({
    id: `${order.id}:race-lost`,
    ref: '11c',
    kind: 'failure',
    icon: 'failed',
    title: 'Cancel failed',
    body:
      fill === null
        ? 'The order was filled first.'
        : `The order was filled first. You received ${receivedText(order, fill.received, 'compact')}.`,
    txid: fill?.txid ?? order.events.find((event) => event.kind === 'execute')?.txid ?? null,
    actions: [viewReceipt(order)],
    durationMs: null,
    flow: { kind: 'cancel', subject: order.id },
  });
};

export const transactionNotSent = (
  flow: MessageFlow & { kind: FlowName },
  requestId: string,
  code: 'WALLET_SESSION_ENDED' | 'SIGNED_TX_MISMATCH',
  reason: string,
  retry: (() => void) | null,
): AppNotification =>
  base({
    id: `${requestId}:${code}`,
    ref: '11d',
    kind: 'failure',
    icon: 'failed',
    title: 'Transaction not sent',
    body: `${reason}. Nothing was sent.`,
    meta: code,
    actions: retry === null ? [] : [{ label: 'Try again', run: retry }],
    durationMs: null,
    flow,
  });

export const registrationDelayed = (input: {
  draftId: string;
  txid: string;
  code: string;
}): AppNotification =>
  base({
    id: `${input.txid}:register-failed`,
    ref: '12',
    kind: 'failure',
    icon: 'failed',
    title: 'Order not registered yet',
    body: 'Your order is funded on chain. AtPrice is retrying registration. You can cancel from Recover any time.',
    meta: input.code,
    txid: input.txid,
    actions: [openInRecover()],
    durationMs: null,
    flow: { kind: 'funding', subject: input.draftId },
  });

export const broadcastUnknown = (input: {
  flow: MessageFlow & { kind: FlowName };
  txid: string;
  checkAgain: () => void;
}): AppNotification =>
  base({
    id: `${input.txid}:broadcast-unknown`,
    ref: '15',
    kind: 'failure',
    icon: 'failed',
    title: 'Broadcast not confirmed',
    body: `Transaction ${truncateMiddle(input.txid)} may or may not have reached the network.`,
    txid: input.txid,
    actions: [{ label: 'Check again', run: input.checkAgain }, openInRecover()],
    durationMs: null,
    flow: input.flow,
  });
