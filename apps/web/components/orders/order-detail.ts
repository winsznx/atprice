import type { Health, KeeperCheck, Order, Ratio } from '@/lib/api/schemas';
import type { NetworkCheck } from '@/lib/hooks/use-network-check';
import { formatPercent } from '@/lib/format';
import { tokenSymbol } from '@/lib/orders/display';
import type { WalletState } from '@/lib/wallet/connector';
import { walletNetworkLabel } from '@/lib/wallet/keys';
import { appNetwork } from '@/lib/network';
import { mismatchReason } from '@/components/shell/network-mismatch-banner';
import { distanceToLimit } from './order-lists';

/*
 * Order detail (order-detail.md) as pure functions: the title block, the owner and cancel rules, the
 * execution condition, keeper freshness and refresh cadence. The page renders their answers.
 */

/** What the connected wallet is to this order (order-detail.md "States"). */
export type Ownership =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'owner'; readonly reconnectingSince: number | null }
  | { readonly kind: 'not_owner' }
  | { readonly kind: 'missing_receive' }
  | { readonly kind: 'wrong_network'; readonly copy: string };

export const ownershipOf = (wallet: WalletState, ownerPkh: string): Ownership => {
  switch (wallet.kind) {
    case 'loading':
    case 'resuming':
      return { kind: 'unknown' };
    case 'connected':
      return wallet.owner.ownerPkhHex === ownerPkh
        ? { kind: 'owner', reconnectingSince: wallet.reconnectingSince }
        : { kind: 'not_owner' };
    case 'missing_receive':
      return { kind: 'missing_receive' };
    case 'wrong_network':
      return {
        kind: 'wrong_network',
        copy: `Your wallet is on ${walletNetworkLabel(wallet.walletNetwork)}. Switch it to ${appNetwork.name} to cancel this order here.`,
      };
    default:
      return { kind: 'disconnected' };
  }
};

export type CancelAvailability =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled'; readonly reason: string; readonly reconnecting: boolean };

/** `Cancel order` rules (order-detail.md "Controls"), checked in a fixed order. */
export const cancelAvailability = (
  order: Pick<Order, 'status'>,
  ownership: Ownership,
  network: NetworkCheck,
): CancelAvailability => {
  if (ownership.kind !== 'owner') return { kind: 'hidden' };
  switch (order.status) {
    case 'FILLED':
    case 'CANCELLED':
      return { kind: 'hidden' };
    case 'EXECUTION_PENDING':
      return {
        kind: 'disabled',
        reason: 'A fill for this order is already waiting for confirmation. A cancel can’t replace it.',
        reconnecting: false,
      };
    case 'CANCELLATION_PENDING':
      return {
        kind: 'disabled',
        reason: 'A cancel is already waiting for confirmation.',
        reconnecting: false,
      };
    case 'RECONCILIATION_REQUIRED':
      return {
        kind: 'disabled',
        reason: 'AtPrice can’t confirm this order’s state. Use Recover, which reads the chain directly.',
        reconnecting: false,
      };
    case 'OPEN':
    case 'FUNDING_PENDING':
      break;
  }
  if (network.status === 'mismatch') {
    return { kind: 'disabled', reason: mismatchReason(network.web, network.api), reconnecting: false };
  }
  if (ownership.reconnectingSince !== null) {
    return { kind: 'disabled', reason: 'reconnecting', reconnecting: true };
  }
  return { kind: 'enabled' };
};

export const RECONNECTING_REASON = (elapsed: string): string =>
  `Reconnecting to your wallet (${elapsed}). Requests resume when it answers.`;

/** Polling by state (order-detail.md "Data sources"); terminal orders stop after 6 confirmations. */
export const orderRefreshInterval = (order: Order | undefined): number | false => {
  if (order === undefined) return false;
  switch (order.status) {
    case 'FUNDING_PENDING':
    case 'EXECUTION_PENDING':
    case 'CANCELLATION_PENDING':
      return 5_000;
    case 'OPEN':
    case 'RECONCILIATION_REQUIRED':
      return 15_000;
    case 'FILLED':
    case 'CANCELLED':
      return (order.settlement?.confirmations ?? 0) >= 6 ? false : 15_000;
  }
};

/** Keeper outcome codes in plain words (order-detail.md "Copy"); an unknown code is printed as sent. */
const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  LIMIT_NOT_MET: 'Limit not met',
  NO_POOL: 'No pool can take this size',
  POOL_SPENT_REBUILT: 'Pool changed, rebuilt from current state',
  EXECUTABLE: 'Limit met',
  not_eligible: 'Limit not met',
  pool_changed: 'Pool changed, rebuilt from current state',
  pool_spent: 'Pool changed, rebuilt from current state',
  broadcast_ok: 'Fill sent',
  broadcast_rejected: 'Fill rejected by the network',
  vm_rejected: 'Fill failed AtPrice’s own check',
  order_spent: 'Order already spent',
  dropped: 'Fill dropped from the mempool',
};

export const outcomeWords = (code: string): { readonly text: string; readonly known: boolean } => {
  const text = OUTCOME_WORDS[code];
  return text === undefined ? { text: code, known: false } : { text, known: true };
};

/** True when the keeper's best quote for the whole order reaches `minOut`, the contract's measure. */
export const checkMet = (order: Pick<Order, 'minOut'>, check: KeeperCheck): boolean =>
  check.bestOutput !== null && check.bestOutput >= order.minOut;

export type Condition =
  | { readonly kind: 'not_checked' }
  | { readonly kind: 'met' }
  | { readonly kind: 'short'; readonly percent: string }
  /** The spot rate reaches the limit, but no single pool pays the minimum for the whole order. */
  | { readonly kind: 'size' }
  | { readonly kind: 'not_met' };

/** The `Execution condition` block for an open order. */
export const executionCondition = (order: Order, spot: Ratio | null): Condition => {
  const check = order.keeperCheck;
  if (check === null) return { kind: 'not_checked' };
  if (checkMet(order, check)) return { kind: 'met' };
  if (spot === null) return { kind: 'not_met' };
  const distance = distanceToLimit(order, spot);
  if (distance === null) return { kind: 'not_met' };
  if (distance.numerator <= 0n) return { kind: 'size' };
  return { kind: 'short', percent: formatPercent(distance.numerator, distance.denominator) };
};

export const conditionText = (condition: Condition): string => {
  switch (condition.kind) {
    case 'not_checked':
      return 'Not checked yet. AtPrice’s keeper checks open orders after their funding confirms.';
    case 'met':
      return 'Met at the last check. AtPrice’s keeper is building the fill, and anyone else may fill it first.';
    case 'short':
      return `Not met yet. The rate now is ${condition.percent} short of your limit.`;
    case 'size':
      return 'Not met yet. The rate now reaches your limit, but at the last check no single pool could pay your minimum for the whole order.';
    case 'not_met':
      return 'Not met yet at the last check.';
  }
};

/** The keeper hasn't checked for more than 2 sweep intervals (order-detail.md "Open"). */
export const keeperStale = (check: KeeperCheck | null, health: Health | undefined, now: number): boolean => {
  if (check === null || health === undefined) return false;
  return now - Date.parse(check.checkedAt) > 2 * health.sweepIntervalMs;
};

/** The spending transaction AtPrice didn't expect, for the reconciliation alert. */
export const unexpectedSpend = (
  order: Pick<Order, 'events'>,
): { readonly txid: string | null; readonly reason: string } => {
  const event =
    order.events.find((candidate) => candidate.kind === 'unknown_spend') ??
    order.events.find((candidate) => candidate.conflict !== null);
  return {
    txid: event?.txid ?? null,
    reason:
      event?.conflict ??
      (event?.kind === 'unknown_spend'
        ? 'the order output was spent by a transaction that is neither a fill nor a cancel'
        : 'observations of this order disagree'),
  };
};

/** A cancel this page saw sent lost to a fill: the timeline shows the failed cancel above `Filled`. */
export const raceLost = (order: Pick<Order, 'status' | 'events'>): boolean =>
  order.status === 'FILLED' &&
  order.events.some(
    (event) =>
      event.kind === 'cancel' && (event.networkState === 'conflicted' || event.networkState === 'replaced'),
  );

/** Breadcrumb target: My orders for the owner, the market for everyone else. */
export const breadcrumbFor = (
  ownership: Ownership,
  order: Pick<Order, 'tokenCategory'>,
  slug: string | null,
): { readonly href: string; readonly label: string } =>
  ownership.kind === 'owner'
    ? { href: '/orders', label: 'My orders' }
    : {
        href: slug === null ? '/markets' : `/markets/${slug}`,
        label: slug === null ? 'Markets' : `BCH/${tokenSymbol(order.tokenCategory)}`,
      };
