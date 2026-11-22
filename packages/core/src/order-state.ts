/**
 * The server-side order state machine (architecture.md r5, order state transition table). This module
 * is the single definition of which status changes are legal; the Postgres trigger in
 * `apps/server/migrations` enforces the same edge set, and a test keeps the two identical.
 *
 * The browser-only states DRAFT and AWAITING_SIGNATURE (PRD 14.1) never reach the server.
 */

export const ORDER_STATUSES = [
  'FUNDING_PENDING',
  'OPEN',
  'EXECUTION_PENDING',
  'CANCELLATION_PENDING',
  'FILLED',
  'CANCELLED',
  'RECONCILIATION_REQUIRED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['FILLED', 'CANCELLED'];
export const NON_TERMINAL_STATUSES: readonly OrderStatus[] = ORDER_STATUSES.filter(
  (status) => !TERMINAL_STATUSES.includes(status),
);

export const isTerminalStatus = (status: OrderStatus): boolean => TERMINAL_STATUSES.includes(status);

/** What the indexer observed. Each edge of the table names the observations that may cause it. */
export type ObservationCause =
  /** Funding transaction seen in the mempool, valid per the order validation rules. */
  | 'funding_seen'
  /** Funding confirmed and the order outpoint unspent. */
  | 'funding_confirmed'
  /** The order outpoint is spent in the mempool (by an execute or a cancel). */
  | 'spend_seen'
  /** The spend of the order outpoint is confirmed. */
  | 'spend_confirmed'
  /** A previously seen spend is gone from mempool and chain after 2 sweeps; the outpoint is unspent. */
  | 'spend_vanished'
  /** Unconfirmed funding is gone from mempool and chain after 2 sweeps. */
  | 'funding_vanished'
  /** Backfill (boot, reconnect or register) found the order already in this state on chain. */
  | 'backfill'
  /** The outpoint was spent by a script path that is neither execute nor cancel. */
  | 'unknown_spend'
  /** A recorded confirmation is no longer in the best chain. */
  | 'reorg'
  /** Two Electrum servers disagree about the order outpoint. */
  | 'server_disagreement'
  /** A fresh full resync of the order outpoint derived the state from chain. */
  | 'resync';

/** `DELETED` is the "(deleted, event kept)" target of a vanished unconfirmed funding. */
export type TransitionTarget = OrderStatus | 'DELETED';

export interface StatusEdge {
  readonly from: OrderStatus | null;
  readonly to: TransitionTarget;
  readonly causes: readonly ObservationCause[];
}

const RECONCILE_CAUSES: readonly ObservationCause[] = ['unknown_spend', 'reorg', 'server_disagreement'];

const edges = (
  from: readonly (OrderStatus | null)[],
  to: readonly TransitionTarget[],
  causes: readonly ObservationCause[],
): StatusEdge[] => from.flatMap((source) => to.map((target) => ({ from: source, to: target, causes })));

/** The transition table, row for row as architecture.md r5 states it. */
export const ORDER_STATUS_EDGES: readonly StatusEdge[] = [
  ...edges([null], ['FUNDING_PENDING'], ['funding_seen']),
  ...edges([null], ['OPEN', 'FILLED', 'CANCELLED'], ['backfill', 'funding_confirmed', 'spend_confirmed']),
  ...edges([null], ['EXECUTION_PENDING', 'CANCELLATION_PENDING'], ['backfill', 'spend_seen']),
  ...edges(['FUNDING_PENDING'], ['OPEN'], ['funding_confirmed']),
  ...edges(['FUNDING_PENDING'], ['DELETED'], ['funding_vanished']),
  ...edges(['OPEN'], ['EXECUTION_PENDING', 'CANCELLATION_PENDING'], ['spend_seen']),
  ...edges(['FUNDING_PENDING'], ['CANCELLATION_PENDING', 'EXECUTION_PENDING'], ['spend_seen']),
  ...edges(['OPEN', 'FUNDING_PENDING'], ['FILLED', 'CANCELLED'], ['spend_confirmed']),
  ...edges(['EXECUTION_PENDING'], ['FILLED'], ['spend_confirmed']),
  ...edges(['CANCELLATION_PENDING'], ['CANCELLED'], ['spend_confirmed']),
  ...edges(['EXECUTION_PENDING'], ['CANCELLATION_PENDING'], ['spend_seen']),
  ...edges(['CANCELLATION_PENDING'], ['EXECUTION_PENDING'], ['spend_seen']),
  ...edges(['EXECUTION_PENDING', 'CANCELLATION_PENDING'], ['OPEN'], ['spend_vanished']),
  ...edges(
    ['FUNDING_PENDING', 'OPEN', 'EXECUTION_PENDING', 'CANCELLATION_PENDING'],
    ['RECONCILIATION_REQUIRED'],
    RECONCILE_CAUSES,
  ),
  ...edges(['FILLED', 'CANCELLED'], ['RECONCILIATION_REQUIRED'], ['reorg']),
  ...edges(
    ['RECONCILIATION_REQUIRED'],
    ['OPEN', 'EXECUTION_PENDING', 'CANCELLATION_PENDING', 'FILLED', 'CANCELLED'],
    ['resync'],
  ),
];

/**
 * The status edges as `(from, to)` pairs, which is what the Postgres trigger enforces. Two rows the
 * transition function can produce outside the cause table are included: a backfill that finds an
 * unknown spend creates the order directly in RECONCILIATION_REQUIRED, and any status may be moved
 * there by a rejected observation (the "no edge" rule), which for terminal states is a reorg.
 */
export const ORDER_STATUS_PAIRS: readonly (readonly [OrderStatus | null, TransitionTarget])[] = (() => {
  const pairs = new Map<string, readonly [OrderStatus | null, TransitionTarget]>();
  const add = (from: OrderStatus | null, to: TransitionTarget): void => {
    pairs.set(`${from ?? '-'}>${to}`, [from, to]);
  };
  for (const edge of ORDER_STATUS_EDGES) add(edge.from, edge.to);
  add(null, 'RECONCILIATION_REQUIRED');
  return [...pairs.values()];
})();

export interface Observation {
  /** The state the observation derives for the order from chain facts. */
  readonly derived: TransitionTarget;
  readonly cause: ObservationCause;
}

export type TransitionDecision =
  /** The observation derives the current state: write a `transaction_events` row, leave the status. */
  | { readonly kind: 'noop'; readonly status: OrderStatus | null }
  /** A table edge: move to `to`. */
  | { readonly kind: 'transition'; readonly from: OrderStatus | null; readonly to: OrderStatus }
  /** FUNDING_PENDING funding vanished: delete the order, keep its events. */
  | { readonly kind: 'delete'; readonly from: OrderStatus }
  /**
   * The observation derives a different state with no edge. The order moves to
   * RECONCILIATION_REQUIRED and the rejected observation is recorded as the cause. When the order is
   * already there, the status stays and only the event is written.
   */
  | {
      readonly kind: 'reconcile';
      readonly from: OrderStatus | null;
      readonly to: 'RECONCILIATION_REQUIRED';
      readonly rejected: Observation;
    };

const findEdge = (from: OrderStatus | null, observation: Observation): StatusEdge | undefined =>
  ORDER_STATUS_EDGES.find(
    (edge) =>
      edge.from === from && edge.to === observation.derived && edge.causes.includes(observation.cause),
  );

/**
 * The single transition function. Same-state observations are a no-op on status and are never
 * rejected, so repeated notifications and reconnect backfills are harmless. Only an observation that
 * derives a different state with no edge moves the order to RECONCILIATION_REQUIRED.
 */
export const decideTransition = (
  current: OrderStatus | null,
  observation: Observation,
): TransitionDecision => {
  if (observation.derived === current) return { kind: 'noop', status: current };
  if (current === null && observation.derived === 'DELETED') return { kind: 'noop', status: null };
  const edge = findEdge(current, observation);
  if (edge !== undefined) {
    if (edge.to === 'DELETED') {
      if (current === null) return { kind: 'noop', status: null };
      return { kind: 'delete', from: current };
    }
    return { kind: 'transition', from: current, to: edge.to };
  }
  if (current === 'RECONCILIATION_REQUIRED') return { kind: 'noop', status: current };
  return { kind: 'reconcile', from: current, to: 'RECONCILIATION_REQUIRED', rejected: observation };
};

/** The status an order holds after a decision, `null` when it is deleted or never created. */
export const statusAfter = (decision: TransitionDecision): OrderStatus | null => {
  switch (decision.kind) {
    case 'noop':
      return decision.status;
    case 'transition':
      return decision.to;
    case 'delete':
      return null;
    case 'reconcile':
      return decision.to;
  }
};

/** What the indexer knows about one order instance from chain data. */
export interface OrderChainFacts {
  readonly funding: 'mempool' | 'confirmed' | 'missing';
  readonly spend:
    | { readonly kind: 'none' }
    | { readonly kind: 'execute' | 'cancel' | 'unknown'; readonly confirmed: boolean };
}

/**
 * The state chain facts derive. A missing funding with no spend derives `DELETED`: the caller only
 * submits it once the funding has been missing for 2 sweeps (`funding_vanished`).
 */
export const deriveOrderState = (facts: OrderChainFacts): TransitionTarget => {
  const { spend } = facts;
  if (spend.kind === 'unknown') return 'RECONCILIATION_REQUIRED';
  if (spend.kind === 'execute') return spend.confirmed ? 'FILLED' : 'EXECUTION_PENDING';
  if (spend.kind === 'cancel') return spend.confirmed ? 'CANCELLED' : 'CANCELLATION_PENDING';
  if (facts.funding === 'confirmed') return 'OPEN';
  if (facts.funding === 'mempool') return 'FUNDING_PENDING';
  return 'DELETED';
};
