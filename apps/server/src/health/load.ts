import { SUPPORTED_MARKETS, type Network } from '@atprice/core';
import type { Queryable } from '../db/pool.js';
import { readFacts } from '../facts.js';
import { executableThresholdMs, judgeHealth, type HealthVerdict } from './judge.js';

export interface HealthConfig {
  readonly network: Network;
  readonly sweepIntervalMs: number;
  readonly evalIntervalMs: number;
}

/** Reads keeper facts and evaluator state from Postgres and judges them at `now`. */
export const loadHealth = async (
  db: Queryable,
  config: HealthConfig,
  now: Date = new Date(),
): Promise<HealthVerdict> => {
  const { network, sweepIntervalMs, evalIntervalMs } = config;
  const facts = await readFacts(db, network);
  const { rows: state } = await db.query<{
    name: string;
    value: { height?: number; server?: string | null; message?: string };
    observed_at: Date;
  }>(`SELECT name, value, observed_at FROM evaluator_state WHERE network = $1`, [network]);
  const tip = state.find((row) => row.name === 'tip');
  const run = state.find((row) => row.name === 'run');
  const failure = state.find((row) => row.name === 'failure');
  const threshold = new Date(now.getTime() - executableThresholdMs(sweepIntervalMs, evalIntervalMs));
  const { rows: unfilled } = await db.query<{ order_id: string; executable_since: Date }>(
    `SELECT order_id, executable_since FROM evaluator_orders
      WHERE network = $1 AND executable_since IS NOT NULL AND executable_since < $2`,
    [network, threshold],
  );
  const { rows: vm } = await db.query<{ count: string }>(
    `SELECT count(DISTINCT o.id) AS count FROM orders o JOIN keeper_attempts a ON a.order_id = o.id
      WHERE o.network = $1 AND o.status = 'OPEN' AND a.outcome = 'vm_rejected'`,
    [network],
  );
  const { rows: disagreements } = await db.query<{ count: string }>(
    `SELECT count(*) AS count FROM evaluator_orders WHERE network = $1 AND quote_disagreement IS NOT NULL`,
    [network],
  );
  return judgeHealth({
    now,
    network,
    sweepIntervalMs,
    evalIntervalMs,
    facts,
    evaluatorTip:
      tip !== undefined && typeof tip.value.height === 'number'
        ? {
            value: {
              height: tip.value.height,
              server: typeof tip.value.server === 'string' ? tip.value.server : null,
            },
            observedAt: tip.observed_at,
          }
        : undefined,
    evaluatorRunAt: run?.observed_at,
    evaluatorFailure:
      failure === undefined
        ? undefined
        : { at: failure.observed_at, message: failure.value.message ?? 'unknown error' },
    marketTokens: SUPPORTED_MARKETS[network].map((market) => market.tokenCategory),
    executableUnfilled: unfilled.map((row) => ({ orderId: row.order_id, since: row.executable_since })),
    vmRejectedOpenOrders: Number(vm[0]?.count ?? 0),
    quoteDisagreements: Number(disagreements[0]?.count ?? 0),
  });
};
