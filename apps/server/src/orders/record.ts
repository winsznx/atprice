import {
  decideTransition,
  deriveOrderState,
  isTerminalStatus,
  type ObservationCause,
  type OrderChainFacts,
  type OrderStatus,
  type TransitionDecision,
  type TransitionTarget,
} from '@atprice/core';
import { withTransaction, type Db, type DbClient } from '../db/pool.js';
import { FACT, writeFact } from '../facts.js';
import { instanceColumns, type OrderInstance } from './model.js';
import type { ObservedTx } from './observe.js';

/** An execution derived from an observed execute transaction (ours or a third party's). */
export interface ExecutionRecord {
  readonly txid: string;
  readonly side: 'buy' | 'sell';
  readonly inputAmount: bigint;
  readonly outputAmount: bigint;
  readonly surplus: bigint;
  readonly networkFee: bigint;
  readonly payoutSatoshis: bigint;
  readonly routeMetadata: Record<string, string | number>;
}

export interface ObservationInput {
  readonly orderId: string;
  readonly network: string;
  /** Required to create the row when the order is not stored yet. */
  readonly instance?: OrderInstance;
  readonly facts: OrderChainFacts;
  readonly funding: ObservedTx | undefined;
  readonly spend: (ObservedTx & { readonly kind: 'execute' | 'cancel' | 'unknown' }) | undefined;
  /** An observation that is not derived from facts, such as a reorg removing a recorded confirmation. */
  readonly forced?: {
    readonly derived: TransitionTarget;
    readonly cause: ObservationCause;
    readonly detail: string;
  };
  /** True when the observation comes from a fallback sweep, which is what vanish counting measures. */
  readonly sweep: boolean;
  /** The observing server's tip height; a recorded confirmation above it is one that server hasn't reached. */
  readonly observerTipHeight?: number;
  readonly execution?: ExecutionRecord;
  readonly detail?: Record<string, unknown>;
}

export interface ObservationOutcome {
  readonly decision: TransitionDecision | { readonly kind: 'skipped'; readonly reason: string };
  readonly previous: OrderStatus | null;
  readonly status: OrderStatus | null;
}

/** Sweeps a vanished transaction must stay vanished before the edge applies (architecture.md table). */
export const VANISH_SWEEPS = 2;

const PENDING: readonly (OrderStatus | null)[] = ['EXECUTION_PENDING', 'CANCELLATION_PENDING'];

/** Picks the observation cause for a derived state; the transition function then checks the edge. */
export const observationCause = (
  current: OrderStatus | null,
  derived: TransitionTarget,
): ObservationCause => {
  if (current === 'RECONCILIATION_REQUIRED') return 'resync';
  if (derived === 'RECONCILIATION_REQUIRED') return 'unknown_spend';
  if (current === null) return derived === 'FUNDING_PENDING' ? 'funding_seen' : 'backfill';
  if (derived === 'DELETED') return 'funding_vanished';
  if (derived === 'FUNDING_PENDING') return 'reorg';
  if (derived === 'OPEN') return current === 'FUNDING_PENDING' ? 'funding_confirmed' : 'spend_vanished';
  if (derived === 'FILLED' || derived === 'CANCELLED') return 'spend_confirmed';
  return 'spend_seen';
};

const isVanishing = (current: OrderStatus | null, derived: TransitionTarget, forced: boolean): boolean =>
  !forced &&
  ((current === 'FUNDING_PENDING' && derived === 'DELETED') ||
    (PENDING.includes(current) && derived === 'OPEN'));

const networkState = (input: ObservationInput): string => {
  if (input.forced?.cause === 'reorg') return 'reorged';
  if (input.forced?.cause === 'server_disagreement') return 'conflict';
  if (input.spend !== undefined) return input.spend.height === null ? 'mempool' : 'confirmed';
  if (input.facts.funding === 'missing' || input.funding === undefined) return 'missing';
  return input.funding.height === null ? 'mempool' : 'confirmed';
};

interface StoredOrder {
  readonly status: OrderStatus;
  readonly vanish_sweeps: number;
  readonly funding_height: number | null;
  readonly spend_txid: string | null;
  readonly spend_height: number | null;
}

/** The highest recorded confirmation this observation no longer shows, if it drops any. */
const droppedConfirmation = (row: StoredOrder, input: ObservationInput): number | undefined => {
  const spendDropped =
    row.spend_height !== null && (input.spend?.txid !== row.spend_txid || input.spend.height === null);
  if (spendDropped) return row.spend_height ?? undefined;
  const fundingDropped =
    row.funding_height !== null && (input.funding === undefined || input.funding.height === null);
  return fundingDropped ? (row.funding_height ?? undefined) : undefined;
};

/*
 * Whether an observation comes from a server that is behind what is already recorded. A terminal
 * order leaves its state only through the header-path reorg check (`checkReorgs`), so any
 * observation deriving something else for it is a disagreement. A non-terminal order ignores an
 * observation that drops a confirmation in a block the observing server hasn't reached yet.
 */
const isBehindRecorded = (row: StoredOrder, input: ObservationInput, derived: TransitionTarget): boolean => {
  if (derived === row.status) return false;
  if (isTerminalStatus(row.status)) return true;
  const dropped = droppedConfirmation(row, input);
  return dropped !== undefined && input.observerTipHeight !== undefined && dropped > input.observerTipHeight;
};

const insertInstance = async (
  client: DbClient,
  instance: OrderInstance,
  status: OrderStatus,
): Promise<boolean> => {
  const columns = { ...instanceColumns(instance), status };
  const names = Object.keys(columns);
  const values = Object.values(columns);
  const result = await client.query(
    `INSERT INTO orders (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (id) DO NOTHING`,
    values,
  );
  return result.rowCount === 1;
};

const chainColumns = (input: ObservationInput): unknown[] => [
  input.funding?.height ?? null,
  input.funding?.blockHash ?? null,
  input.spend?.txid ?? null,
  input.spend?.kind ?? null,
  input.spend?.height ?? null,
  input.spend?.blockHash ?? null,
];

const writeEvent = async (
  client: DbClient,
  input: ObservationInput,
  decision: TransitionDecision,
  from: OrderStatus | null,
  to: TransitionTarget | null,
  cause: ObservationCause,
): Promise<void> => {
  const relevant = input.spend ?? input.funding;
  const detail = {
    ...input.detail,
    ...(decision.kind === 'reconcile' && { rejected: decision.rejected }),
    ...(input.forced && { forced: input.forced.detail }),
    facts: input.facts,
  };
  await client.query(
    `INSERT INTO transaction_events
       (order_id, network, txid, cause, decision, from_status, to_status, network_state, block_height, block_hash, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.orderId,
      input.network,
      relevant?.txid ?? null,
      cause,
      decision.kind,
      from,
      to,
      networkState(input),
      relevant?.height ?? null,
      relevant?.blockHash ?? null,
      JSON.stringify(detail),
    ],
  );
};

const upsertExecution = async (
  client: DbClient,
  input: ObservationInput,
  execution: ExecutionRecord,
): Promise<void> => {
  const confirmed = input.spend?.height !== null && input.spend?.height !== undefined;
  const { rows } = await client.query<{
    status: string;
    by_atprice_keeper: boolean;
    block_height: number | null;
    block_hash: string | null;
  }>(
    `INSERT INTO executions
       (order_id, network, txid, side, input_amount, output_amount, surplus, network_fee, payout_satoshis, route_metadata,
        by_atprice_keeper, status, block_height, block_hash, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        EXISTS (SELECT 1 FROM keeper_attempts WHERE txid = $3), $11, $12, $13, CASE WHEN $11 = 'confirmed' THEN now() END)
     ON CONFLICT (txid) DO UPDATE SET
       status = CASE WHEN executions.status = 'confirmed' THEN executions.status ELSE EXCLUDED.status END,
       block_height = CASE WHEN executions.status = 'confirmed' THEN executions.block_height ELSE EXCLUDED.block_height END,
       block_hash = CASE WHEN executions.status = 'confirmed' THEN executions.block_hash ELSE EXCLUDED.block_hash END,
       by_atprice_keeper = EXCLUDED.by_atprice_keeper OR executions.by_atprice_keeper,
       confirmed_at = CASE
         WHEN executions.status = 'confirmed' THEN executions.confirmed_at
         WHEN EXCLUDED.status = 'confirmed' THEN now()
       END
     RETURNING status, by_atprice_keeper, block_height, block_hash`,
    [
      input.orderId,
      input.network,
      execution.txid,
      execution.side,
      execution.inputAmount.toString(),
      execution.outputAmount.toString(),
      execution.surplus.toString(),
      execution.networkFee.toString(),
      execution.payoutSatoshis.toString(),
      JSON.stringify(execution.routeMetadata),
      confirmed ? 'confirmed' : 'pending',
      input.spend?.height ?? null,
      input.spend?.blockHash ?? null,
    ],
  );
  const stored = rows[0];
  if (stored?.status === 'confirmed' && stored.by_atprice_keeper) {
    await writeFact(client, input.network, FACT.lastConfirmedFill, {
      txid: execution.txid,
      orderId: input.orderId,
      blockHeight: stored.block_height,
      blockHash: stored.block_hash,
    });
  }
};

/**
 * Applies one observation to one order in one transaction: the transition function decides, the
 * trigger re-checks the edge, and every observation writes a `transaction_events` row with its cause.
 */
export const recordObservation = async (db: Db, input: ObservationInput): Promise<ObservationOutcome> =>
  withTransaction(db, async (client) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { rows } = await client.query<StoredOrder>(
        `SELECT status, vanish_sweeps, funding_height, spend_txid, spend_height
           FROM orders WHERE id = $1 FOR UPDATE`,
        [input.orderId],
      );
      const row = rows[0];
      const current = row?.status ?? null;
      const derived = input.forced?.derived ?? deriveOrderState(input.facts);
      if (current === null && derived === 'DELETED') {
        return { decision: { kind: 'skipped', reason: 'funding_not_found' }, previous: null, status: null };
      }
      if (row !== undefined && input.forced === undefined && isBehindRecorded(row, input, derived)) {
        const decision: TransitionDecision = { kind: 'noop', status: row.status };
        await writeEvent(
          client,
          { ...input, detail: { ...input.detail, derived, observerTipHeight: input.observerTipHeight } },
          decision,
          row.status,
          row.status,
          'server_disagreement',
        );
        return { decision, previous: row.status, status: row.status };
      }
      const cause = input.forced?.cause ?? observationCause(current, derived);

      if (
        row !== undefined &&
        current !== derived &&
        isVanishing(current, derived, input.forced !== undefined)
      ) {
        const sweeps = row.vanish_sweeps + (input.sweep ? 1 : 0);
        if (sweeps < VANISH_SWEEPS) {
          if (sweeps !== row.vanish_sweeps) {
            await client.query('UPDATE orders SET vanish_sweeps = $2 WHERE id = $1', [input.orderId, sweeps]);
            const pending: TransitionDecision = { kind: 'noop', status: current };
            await writeEvent(
              client,
              { ...input, detail: { ...input.detail, vanishSweeps: sweeps } },
              pending,
              current,
              current,
              cause,
            );
          }
          return {
            decision: { kind: 'skipped', reason: 'vanish_unconfirmed' },
            previous: current,
            status: current,
          };
        }
      }

      const decision = decideTransition(current, { derived, cause });
      if (row === undefined) {
        if (input.instance === undefined) {
          return { decision: { kind: 'skipped', reason: 'unknown_order' }, previous: null, status: null };
        }
        const target = decision.kind === 'transition' || decision.kind === 'reconcile' ? decision.to : null;
        if (target === null) return { decision, previous: null, status: null };
        const inserted = await insertInstance(client, input.instance, target);
        if (!inserted) continue;
      } else if (decision.kind === 'delete') {
        await writeEvent(client, input, decision, current, 'DELETED', cause);
        await client.query('DELETE FROM orders WHERE id = $1', [input.orderId]);
        return { decision, previous: current, status: null };
      } else if (input.forced !== undefined) {
        // A forced observation carries no fresh chain facts, so the recorded heights and hashes stay.
        const status = decision.kind === 'noop' ? current : decision.to;
        await client.query('UPDATE orders SET status = $2, vanish_sweeps = 0 WHERE id = $1', [
          input.orderId,
          status,
        ]);
      } else {
        const status = decision.kind === 'noop' ? current : decision.to;
        await client.query(
          `UPDATE orders SET status = $2, funding_height = $3, funding_block_hash = $4, spend_txid = $5, spend_kind = $6,
             spend_height = $7, spend_block_hash = $8, vanish_sweeps = 0
           WHERE id = $1`,
          [input.orderId, status, ...chainColumns(input)],
        );
      }
      if (row === undefined) {
        await client.query(
          `UPDATE orders SET funding_height = $2, funding_block_hash = $3, spend_txid = $4, spend_kind = $5,
             spend_height = $6, spend_block_hash = $7 WHERE id = $1`,
          [input.orderId, ...chainColumns(input)],
        );
      }
      const after = decision.kind === 'noop' ? current : decision.kind === 'delete' ? null : decision.to;
      await writeEvent(client, input, decision, current, after, cause);
      if (input.execution !== undefined) await upsertExecution(client, input, input.execution);
      return { decision, previous: current, status: after };
    }
    throw new Error(`order ${input.orderId} changed concurrently twice; giving up this observation`);
  });

/** Marks executions confirmed in a reorged-out block. */
export const markReorgedExecutions = async (db: Db, blockHash: string): Promise<void> => {
  await db.query(`UPDATE executions SET status = 'reorged' WHERE block_hash = $1 AND status = 'confirmed'`, [
    blockHash,
  ]);
};
