import type { Order, TransactionEvent } from '../api/schemas';
import { formatBlockHeight } from '../format';
import { minimumText, receivedText } from './display';

export type StepState = 'done' | 'current' | 'upcoming' | 'failed' | 'review';
export type StepTone = 'pending' | 'open' | 'filled' | 'cancelled' | 'failed' | 'review' | 'upcoming';

export interface TimelineStep {
  readonly id: string;
  readonly label: string;
  /** Plain-text meta line (time is rendered separately from `at`). */
  readonly meta: string | null;
  readonly at: string | null;
  readonly state: StepState;
  readonly tone: StepTone;
  /** True for attempts (`sent`): never shown with a check icon (DD 7.5, M-08). */
  readonly attempt: boolean;
  readonly txid: string | null;
  /** Spoken name: `funding confirmed in block 925,114`. */
  readonly spoken: string;
}

const confirmedMeta = (event: TransactionEvent): string =>
  event.blockHeight === null
    ? 'Confirmed'
    : `${event.confirmations.toLocaleString('en-US')} ${event.confirmations === 1 ? 'confirmation' : 'confirmations'}, block ${formatBlockHeight(event.blockHeight)}`;

const settlementStep = (event: TransactionEvent, kind: 'fill' | 'cancel'): TimelineStep => {
  const confirmed = event.confirmations > 0;
  const lost = event.networkState === 'conflicted' || event.networkState === 'replaced';
  const noun = kind === 'fill' ? 'Fill' : 'Cancel';
  if (lost) {
    const reason =
      event.conflict ?? (kind === 'cancel' ? 'the order was filled first' : 'the transaction was replaced');
    return {
      id: `${kind}-${event.txid}`,
      label: `${noun} failed: ${reason}`,
      meta: null,
      at: event.firstSeenAt,
      state: 'failed',
      tone: 'failed',
      attempt: false,
      txid: event.txid,
      spoken: `${noun.toLowerCase()} failed, ${reason}`,
    };
  }
  const fact = kind === 'fill' ? 'Filled' : 'Cancelled';
  return {
    id: `${kind}-${event.txid}`,
    label: confirmed ? fact : `${noun} sent`,
    meta: confirmed ? confirmedMeta(event) : 'Not confirmed yet',
    at: event.firstSeenAt,
    state: confirmed ? 'done' : 'current',
    tone: confirmed ? (kind === 'fill' ? 'filled' : 'cancelled') : 'pending',
    attempt: !confirmed,
    txid: event.txid,
    spoken: confirmed
      ? `${fact.toLowerCase()}${event.blockHeight === null ? '' : ` in block ${formatBlockHeight(event.blockHeight)}`}`
      : `${noun.toLowerCase()} sent, not confirmed yet`,
  };
};

const keeperMeta = (order: Order): string => {
  const check = order.keeperCheck;
  if (check === null) return 'AtPrice’s keeper has not checked this order yet';
  if (check.bestOutput === null) return `AtPrice’s keeper: ${check.outcome}`;
  return `AtPrice’s keeper: best pool pays ${receivedText(order, check.bestOutput, 'compact')}, needs ${minimumText(order, 'compact')}`;
};

/**
 * DD 7.5 steps from chain observations only: there is no "prepared" step, attempts and facts differ
 * in wording and icon, and the upcoming step is a hollow node until a fill or cancel is seen.
 */
export const timelineSteps = (order: Order): TimelineStep[] => {
  const steps: TimelineStep[] = [];
  const funding = order.events.find((event) => event.kind === 'funding');
  const fundingConfirmed = funding !== undefined && funding.confirmations > 0;
  if (funding !== undefined) {
    steps.push({
      id: 'funding',
      label: fundingConfirmed ? 'Funding confirmed' : 'Funding sent',
      meta: fundingConfirmed ? confirmedMeta(funding) : 'Not confirmed yet',
      at: funding.firstSeenAt,
      state: fundingConfirmed ? 'done' : 'current',
      tone: fundingConfirmed ? 'filled' : 'pending',
      attempt: !fundingConfirmed,
      txid: funding.txid,
      spoken:
        fundingConfirmed && funding.blockHeight !== null
          ? `funding confirmed in block ${formatBlockHeight(funding.blockHeight)}`
          : fundingConfirmed
            ? 'funding confirmed'
            : 'funding sent, not confirmed yet',
    });
  }
  const settlements = order.events.filter((event) => event.kind === 'execute' || event.kind === 'cancel');
  if (fundingConfirmed) {
    steps.push({
      id: 'watching',
      label: 'Watching pools',
      meta: keeperMeta(order),
      at: order.keeperCheck?.checkedAt ?? null,
      state: order.status === 'OPEN' ? 'current' : 'done',
      tone: 'open',
      attempt: false,
      txid: null,
      spoken: `watching pools, ${keeperMeta(order)}`,
    });
  }
  for (const event of settlements)
    steps.push(settlementStep(event, event.kind === 'execute' ? 'fill' : 'cancel'));
  if (order.status === 'RECONCILIATION_REQUIRED') {
    const conflict =
      order.events.find((event) => event.conflict !== null)?.conflict ?? 'observations disagree';
    steps.push({
      id: 'review',
      label: `Needs review: ${conflict}`,
      meta: null,
      at: order.updatedAt,
      state: 'review',
      tone: 'review',
      attempt: false,
      txid: null,
      spoken: `needs review, ${conflict}`,
    });
  }
  const settled = settlements.some(
    (event) => event.networkState !== 'conflicted' && event.networkState !== 'replaced',
  );
  if (!settled && order.status !== 'RECONCILIATION_REQUIRED') {
    steps.push({
      id: 'upcoming',
      label: 'Filled or cancelled',
      meta: null,
      at: null,
      state: 'upcoming',
      tone: 'upcoming',
      attempt: false,
      txid: null,
      spoken: 'filled or cancelled, not yet',
    });
  }
  return steps;
};
