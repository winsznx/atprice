import { hexToBin } from '@bitauth/libauth';
import ExchangeLab, { InsufficientCapitalInPools } from '@cashlab/cauldron/exchange-lab.js';
import type { PoolV0 } from '@cashlab/cauldron/types.js';
import { NATIVE_BCH_TOKEN_ID } from '@cashlab/common/constants.js';
import { InsufficientFunds } from '@cashlab/common/exceptions.js';
import type { ChainHeader, ChainUtxo } from '@atprice/chain';
import {
  pinnedSupply,
  recipientAmount,
  type EvaluatedOrderUtxo,
  type Network,
  type OrderSide,
} from '@atprice/core';
import type { Db } from '../db/pool.js';
import type { KeeperEvaluation } from '../orders/model.js';
import { keeperExecuteFee } from '../pools/quote.js';
import type { LivePool } from '../pools/reader.js';

export interface EvaluatorChain {
  getTip(): Promise<ChainHeader>;
  getUtxos(lockingBytecode: Uint8Array): Promise<ChainUtxo[]>;
  readonly endpointHost?: string | undefined;
}

/** Pools the evaluator reads itself (Cauldron indexer + its own Electrum connection), never through the keeper. */
export type EvaluatorPoolSource = (tokenId: string) => Promise<readonly LivePool[]>;

export interface EvaluatorDeps {
  readonly db: Db;
  readonly network: Network;
  readonly chain: EvaluatorChain;
  readonly pools: EvaluatorPoolSource;
  readonly now?: () => Date;
}

export interface EvaluatorOrderResult {
  readonly orderId: string;
  readonly state: 'not_confirmed_unspent' | 'executable' | 'not_executable';
  readonly bestRecipientAmount: string | null;
  readonly disagreement: {
    readonly poolOutpoint: string;
    readonly keeper: string;
    readonly evaluator: string;
  } | null;
}

export interface EvaluatorRun {
  readonly at: Date;
  readonly tipHeight: number;
  readonly candidates: number;
  readonly results: readonly EvaluatorOrderResult[];
}

interface CandidateRow {
  readonly id: string;
  readonly side: OrderSide;
  readonly token_id: string;
  readonly min_out: string;
  readonly max_network_fee: string;
  readonly funding_txid: string;
  readonly funding_vout: number;
  readonly order_locking_bytecode: string;
  readonly satoshis: string;
  readonly token_amount: string;
  readonly last_evaluation: KeeperEvaluation | null;
}

const lab = new ExchangeLab();

const cashlabPool = (pool: LivePool): PoolV0 => {
  const parameters = { withdraw_pubkey_hash: pool.ownerPkh };
  return {
    version: '0',
    parameters,
    outpoint: { txhash: hexToBin(pool.txid), index: pool.vout },
    output: {
      locking_bytecode: lab.generatePoolV0LockingBytecode(parameters),
      amount: pool.reserves.sats,
      token: { amount: pool.reserves.tokens, token_id: pool.token.category },
    },
  };
};

/**
 * Quotes one pool with `@cashlab/cauldron` ExchangeLab: a different implementation from the keeper's
 * core maths. `txfee_per_byte = 0` so ExchangeLab's pool elimination never changes the answer.
 */
export const exchangeLabOutput = (side: OrderSide, pool: LivePool, supply: bigint): bigint | undefined => {
  if (supply <= 0n) return undefined;
  try {
    const trade =
      side === 'buy'
        ? lab.constructTradeBestRateForTargetSupply(
            NATIVE_BCH_TOKEN_ID,
            pool.token.category,
            supply,
            [cashlabPool(pool)],
            0n,
          )
        : lab.constructTradeBestRateForTargetSupply(
            pool.token.category,
            NATIVE_BCH_TOKEN_ID,
            supply,
            [cashlabPool(pool)],
            0n,
          );
    const entry = trade?.entries[0];
    if (entry === undefined || trade?.entries.length !== 1) return undefined;
    return entry.demand;
  } catch (error) {
    // Only "this pool cannot take the supply" means no quote. Anything else is an evaluator defect and
    // must surface as evaluator_unavailable, never as "not executable" (which would let /health say ok).
    if (error instanceof InsufficientCapitalInPools || error instanceof InsufficientFunds) return undefined;
    throw error;
  }
};

const NON_TERMINAL = [
  'FUNDING_PENDING',
  'OPEN',
  'EXECUTION_PENDING',
  'CANCELLATION_PENDING',
  'RECONCILIATION_REQUIRED',
];

/**
 * The API's independent evaluator (architecture.md, health). It owns its clock and its candidate set:
 * every supported non-terminal instance whose funding outpoint its own server shows confirmed and
 * unspent, whatever the keeper's status column says.
 */
export class IndependentEvaluator {
  private readonly now: () => Date;

  constructor(private readonly deps: EvaluatorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** One evaluation pass; a failure is recorded with its time so health reports it at once. */
  async run(): Promise<EvaluatorRun> {
    try {
      return await this.evaluate();
    } catch (error) {
      await this.writeState(
        'failure',
        { message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        this.now(),
      );
      throw error;
    }
  }

  private async evaluate(): Promise<EvaluatorRun> {
    const { db, network, chain } = this.deps;
    const at = this.now();
    const tip = await chain.getTip();
    await this.writeState(
      'tip',
      { height: tip.height, hash: tip.hash, server: chain.endpointHost ?? null },
      at,
    );

    const { rows } = await db.query<CandidateRow>(
      `SELECT id, side, token_id, min_out, max_network_fee, funding_txid, funding_vout, order_locking_bytecode, satoshis,
              token_amount, last_evaluation
         FROM orders WHERE network = $1 AND supported AND status = ANY($2::order_status[])`,
      [network, NON_TERMINAL],
    );

    const confirmed: CandidateRow[] = [];
    const results: EvaluatorOrderResult[] = [];
    for (const row of rows) {
      const utxos = await chain.getUtxos(hexToBin(row.order_locking_bytecode));
      const live = utxos.find(
        (utxo) => utxo.txid === row.funding_txid && utxo.vout === row.funding_vout && utxo.height > 0,
      );
      if (live === undefined) {
        const result: EvaluatorOrderResult = {
          orderId: row.id,
          state: 'not_confirmed_unspent',
          bestRecipientAmount: null,
          disagreement: null,
        };
        await this.store(row.id, false, result, at);
        results.push(result);
      } else {
        confirmed.push(row);
      }
    }

    const poolsByToken = new Map<string, readonly LivePool[]>();
    for (const token of new Set(confirmed.map((row) => row.token_id))) {
      poolsByToken.set(token, await this.deps.pools(token));
    }

    for (const row of confirmed) {
      const pools = poolsByToken.get(row.token_id) ?? [];
      const order: EvaluatedOrderUtxo = {
        side: row.side,
        satoshis: BigInt(row.satoshis),
        tokenAmount: BigInt(row.token_amount),
      };
      const fee = keeperExecuteFee(BigInt(row.max_network_fee));
      const supply = pinnedSupply(order, fee);
      let best: bigint | undefined;
      const outputs = new Map<string, bigint>();
      for (const pool of pools) {
        const output = exchangeLabOutput(row.side, pool, supply);
        if (output === undefined) continue;
        outputs.set(pool.outpoint, output);
        const received = recipientAmount(order, output, fee);
        if (best === undefined || received > best) best = received;
      }
      const executable = best !== undefined && best >= BigInt(row.min_out);
      const keeper = row.last_evaluation;
      let disagreement: EvaluatorOrderResult['disagreement'] = null;
      if (keeper?.poolOutpoint && keeper.output !== null && BigInt(keeper.supply) === supply) {
        const mine = outputs.get(keeper.poolOutpoint);
        if (mine !== undefined && mine !== BigInt(keeper.output)) {
          disagreement = {
            poolOutpoint: keeper.poolOutpoint,
            keeper: keeper.output,
            evaluator: mine.toString(),
          };
        }
      }
      const result: EvaluatorOrderResult = {
        orderId: row.id,
        state: executable ? 'executable' : 'not_executable',
        bestRecipientAmount: best?.toString() ?? null,
        disagreement,
      };
      await this.store(row.id, executable, result, at);
      results.push(result);
    }

    const ids = rows.map((row) => row.id);
    await db.query('DELETE FROM evaluator_orders WHERE network = $1 AND NOT (order_id = ANY($2::text[]))', [
      network,
      ids,
    ]);
    await this.writeState('run', { candidates: rows.length, confirmedUnspent: confirmed.length }, at);
    return { at, tipHeight: tip.height, candidates: rows.length, results };
  }

  private async store(
    orderId: string,
    executable: boolean,
    result: EvaluatorOrderResult,
    at: Date,
  ): Promise<void> {
    await this.deps.db.query(
      `INSERT INTO evaluator_orders (network, order_id, executable_since, last_checked_at, last_result, quote_disagreement)
       VALUES ($1, $2, CASE WHEN $3 THEN $4::timestamptz END, $4, $5, $6)
       ON CONFLICT (network, order_id) DO UPDATE SET
         executable_since = CASE WHEN $3 THEN COALESCE(evaluator_orders.executable_since, $4::timestamptz) END,
         last_checked_at = $4, last_result = EXCLUDED.last_result, quote_disagreement = EXCLUDED.quote_disagreement`,
      [
        this.deps.network,
        orderId,
        executable,
        at,
        JSON.stringify(result),
        result.disagreement === null ? null : JSON.stringify(result.disagreement),
      ],
    );
  }

  private async writeState(name: string, value: unknown, at: Date): Promise<void> {
    await this.deps.db.query(
      `INSERT INTO evaluator_state (network, name, value, observed_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (network, name) DO UPDATE SET value = EXCLUDED.value, observed_at = EXCLUDED.observed_at`,
      [this.deps.network, name, JSON.stringify(value), at],
    );
  }
}
