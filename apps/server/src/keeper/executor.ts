import { binToHex } from '@bitauth/libauth';
import type { NetworkProvider, Utxo } from 'cashscript';
import {
  BroadcastRejectedError,
  isAlreadyKnownRejection,
  isSpentInputRejection,
  type ChainUtxo,
  type TransactionStatus,
} from '@atprice/chain';
import {
  InvalidPoolError,
  OrderNotExecutableError,
  buildExecuteTransaction,
  instantiateOrder,
  orderLockingBytecode,
  poolLockingBytecode,
  type CauldronPoolUtxo,
  type Network,
} from '@atprice/core';
import type { Logger } from 'pino';
import type { Analytics } from '../analytics.js';
import type { Db } from '../db/pool.js';
import { FACT, poolFactName, writeFact } from '../facts.js';
import { paramsFromRow, type KeeperEvaluation, type OrderRow } from '../orders/model.js';
import {
  bestPoolQuote,
  keeperExecuteFee,
  quotePool,
  CORE_MATHS,
  type PoolMaths,
  type PoolQuote,
} from '../pools/quote.js';
import { livePoolFromUtxo, readLivePools, type LivePool, type PoolNominator } from '../pools/reader.js';

export interface ExecutorChain {
  getUtxos(lockingBytecode: Uint8Array): Promise<ChainUtxo[]>;
  getTransactionStatus(txid: string): Promise<TransactionStatus>;
}

export interface Broadcaster {
  readonly name: 'electrum' | 'cauldron';
  broadcast(hex: string): Promise<string>;
}

export type AttemptOutcome =
  | 'pool_changed'
  | 'vm_rejected'
  | 'broadcast_rejected'
  | 'order_spent'
  | 'pool_spent'
  | 'broadcast_ok'
  | 'dropped';

export interface ExecutorDeps {
  readonly db: Db;
  readonly network: Network;
  readonly chain: ExecutorChain;
  readonly provider: NetworkProvider;
  readonly nominator: PoolNominator;
  /** The primary Electrum broadcaster first, then the Cauldron endpoint where one exists. */
  readonly broadcasters: readonly Broadcaster[];
  readonly keeperId: string;
  readonly logger: Logger;
  readonly analytics: Analytics;
  readonly maths?: PoolMaths;
  readonly leaseMs?: number;
  /** Called when the order outpoint turns out to be spent: resync that order now (architecture.md). */
  readonly onOrderSpent: (orderId: string) => Promise<void>;
  readonly now?: () => Date;
}

export interface AttemptResult {
  readonly orderId: string;
  readonly outcome: AttemptOutcome | 'not_eligible' | 'lease_held';
  readonly attemptId?: string;
  readonly txid?: string;
  readonly reason?: string;
}

export interface RunSummary {
  readonly tokenId: string;
  readonly trigger: string;
  readonly pools: number;
  readonly evaluated: number;
  readonly executable: number;
  readonly attempts: readonly AttemptResult[];
}

interface CandidateRow extends OrderRow {
  readonly last_outcome: string | null;
  readonly last_retry_after: Date | null;
  readonly vm_rejected: boolean;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;
/** A chained pool output may take a moment to show in the server's mempool view. */
const CHAINED_REREAD_ATTEMPTS = 4;
const CHAINED_REREAD_DELAY_MS = 250;

export const broadcastBackoffMs = (consecutiveRejections: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** Math.max(consecutiveRejections - 1, 0), BACKOFF_CAP_MS);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The executor (architecture.md, keeper): per trigger it reads the token's pools once, evaluates every
 * OPEN order in memory with core's exact maths, and works through candidates per pool, oldest first,
 * with one attempt in flight per pool. After `broadcast_ok` the next candidate builds on the
 * unconfirmed pool output 0 of the previous fill.
 */
export class Executor {
  private readonly maths: PoolMaths;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly running = new Map<string, Promise<RunSummary>>();
  private readonly rerun = new Map<string, string>();

  constructor(private readonly deps: ExecutorDeps) {
    this.maths = deps.maths ?? CORE_MATHS;
    this.leaseMs = deps.leaseMs ?? 120_000;
    this.now = deps.now ?? (() => new Date());
  }

  /** Resolves once every run already started, and its follow-up, has finished (orderly shutdown). */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  /**
   * Runs the executor for a token. Triggers that arrive during a run coalesce into one follow-up run,
   * so a burst of pool events never queues more than one extra pass.
   */
  async trigger(
    tokenId: string,
    reason: string,
    eventAt: Date = this.now(),
  ): Promise<RunSummary | undefined> {
    const inFlight = this.running.get(tokenId);
    if (inFlight !== undefined) {
      this.rerun.set(tokenId, reason);
      return undefined;
    }
    const run = this.runToken(tokenId, reason, eventAt).finally(() => {
      this.running.delete(tokenId);
      const again = this.rerun.get(tokenId);
      if (again !== undefined) {
        this.rerun.delete(tokenId);
        void this.trigger(tokenId, again).catch((error: unknown) =>
          this.deps.logger.error({ err: error, tokenId }, 'executor follow-up run failed'),
        );
      }
    });
    this.running.set(tokenId, run);
    return run;
  }

  async runToken(tokenId: string, trigger: string, eventAt: Date = this.now()): Promise<RunSummary> {
    const { db, network, chain, nominator } = this.deps;
    const read = await readLivePools(chain, tokenId, await nominator.nominate(tokenId));
    await this.recordPools(tokenId, read.pools, read.unconfirmedNominations, read.unnominatedLive);

    const { rows } = await db.query<CandidateRow>(
      `SELECT o.*, last.outcome AS last_outcome, last.retry_after AS last_retry_after,
              EXISTS (SELECT 1 FROM keeper_attempts v WHERE v.order_id = o.id AND v.outcome = 'vm_rejected') AS vm_rejected
         FROM orders o
         LEFT JOIN LATERAL (
           SELECT outcome, retry_after FROM keeper_attempts a WHERE a.order_id = o.id ORDER BY a.started_at DESC LIMIT 1
         ) last ON true
        WHERE o.network = $1 AND o.token_id = $2 AND o.status = 'OPEN' AND o.supported
        ORDER BY o.funding_height NULLS LAST, o.created_at, o.id`,
      [network, tokenId],
    );

    const now = this.now();
    const byPool = new Map<string, { quote: PoolQuote; row: CandidateRow }[]>();
    let executable = 0;
    for (const row of rows) {
      const order = { side: row.side, satoshis: BigInt(row.satoshis), tokenAmount: BigInt(row.token_amount) };
      const fee = keeperExecuteFee(BigInt(row.max_network_fee));
      const best = bestPoolQuote(this.maths, order, read.pools, fee);
      const isExecutable = best !== undefined && best.recipientAmount >= BigInt(row.min_out);
      await this.storeEvaluation(
        row,
        best,
        order.side === 'buy' ? order.satoshis : order.tokenAmount,
        fee,
        isExecutable,
        now,
      );
      if (!isExecutable || best === undefined) continue;
      executable += 1;
      if (row.vm_rejected) continue;
      if (row.last_outcome === 'broadcast_ok' || row.last_outcome === 'built') continue;
      if (
        row.last_outcome === 'broadcast_rejected' &&
        row.last_retry_after !== null &&
        row.last_retry_after > now
      )
        continue;
      const group = byPool.get(best.pool.outpoint) ?? [];
      group.push({ quote: best, row });
      byPool.set(best.pool.outpoint, group);
    }

    const attempts: AttemptResult[] = [];
    for (const group of byPool.values()) {
      let pool: LivePool | undefined = group[0]?.quote.pool;
      let chainedFrom: string | undefined;
      for (const { row, quote: original } of group) {
        if (pool === undefined) break;
        const order = {
          side: row.side,
          satoshis: BigInt(row.satoshis),
          tokenAmount: BigInt(row.token_amount),
        };
        const fee = keeperExecuteFee(BigInt(row.max_network_fee));
        const quote = chainedFrom === undefined ? original : quotePool(this.maths, order, pool, fee);
        if (quote === undefined || quote.recipientAmount < BigInt(row.min_out)) {
          attempts.push({ orderId: row.id, outcome: 'not_eligible' });
          continue;
        }
        const result = await this.attempt(row, quote, fee, chainedFrom, eventAt);
        attempts.push(result.result);
        if (result.result.outcome === 'broadcast_ok') {
          pool = result.nextPool;
          chainedFrom = result.result.attemptId;
        } else if (result.result.outcome === 'pool_changed' || result.result.outcome === 'pool_spent') {
          break;
        }
      }
    }
    return { tokenId, trigger, pools: read.pools.length, evaluated: rows.length, executable, attempts };
  }

  private async recordPools(
    tokenId: string,
    pools: readonly LivePool[],
    unconfirmed: readonly string[],
    unnominated: readonly string[],
  ): Promise<void> {
    const { db, network } = this.deps;
    const liquiditySats = pools.reduce((sum, pool) => sum + pool.reserves.sats, 0n);
    const liquidityTokens = pools.reduce((sum, pool) => sum + pool.reserves.tokens, 0n);
    const observedAt = this.now();
    await writeFact(
      db,
      network,
      poolFactName(tokenId),
      {
        pools: pools.length,
        liquiditySats: liquiditySats.toString(),
        liquidityTokens: liquidityTokens.toString(),
        source: 'nominated+electrum',
        crossCheck: { nominatedNotLive: unconfirmed.length, liveNotNominated: unnominated.length },
      },
      observedAt,
    );
    await db.query(
      `UPDATE markets SET pool_count = $3, liquidity_sats = $4, liquidity_tokens = $5, last_pool_update_at = $6, updated_at = now()
        WHERE network = $1 AND token_id = $2`,
      [network, tokenId, pools.length, liquiditySats.toString(), liquidityTokens.toString(), observedAt],
    );
  }

  private async storeEvaluation(
    row: OrderRow,
    best: PoolQuote | undefined,
    orderAmount: bigint,
    fee: bigint,
    executable: boolean,
    now: Date,
  ): Promise<void> {
    const supply = best?.supply ?? (row.side === 'buy' ? orderAmount - 1000n - fee : orderAmount);
    const evaluation: KeeperEvaluation = {
      poolOutpoint: best?.pool.outpoint ?? null,
      poolOwnerPkh: best?.pool.ownerPkhHex ?? null,
      supply: supply.toString(),
      output: best?.output.toString() ?? null,
      recipientAmount: best?.recipientAmount.toString() ?? null,
      executable,
      evaluatedAt: now.toISOString(),
    };
    // keeper_executable_since is a metric only; health never reads it (architecture.md, executor).
    await this.deps.db.query(
      `UPDATE orders SET last_evaluation = $2, last_evaluated_at = $3,
         keeper_executable_since = CASE WHEN $4 THEN COALESCE(keeper_executable_since, $3) ELSE NULL END
       WHERE id = $1`,
      [row.id, JSON.stringify(evaluation), now, executable],
    );
    if (executable && row.keeper_executable_since === null) {
      this.deps.analytics.emit('execution_eligible', {
        orderId: row.id,
        side: row.side,
        tokenId: row.token_id,
        poolOutpoint: evaluation.poolOutpoint,
      });
    }
  }

  private async claim(orderId: string): Promise<boolean> {
    const { rowCount } = await this.deps.db.query(
      `UPDATE orders SET claimed_by = $2, claimed_until = now() + ($3::int * interval '1 millisecond')
        WHERE id = $1 AND status = 'OPEN' AND (claimed_until IS NULL OR claimed_until < now() OR claimed_by = $2)`,
      [orderId, this.deps.keeperId, this.leaseMs],
    );
    return rowCount === 1;
  }

  private async release(orderId: string): Promise<void> {
    await this.deps.db.query(
      'UPDATE orders SET claimed_by = NULL, claimed_until = NULL WHERE id = $1 AND claimed_by = $2',
      [orderId, this.deps.keeperId],
    );
  }

  private async rereadPool(pool: LivePool, chained: boolean): Promise<LivePool | undefined> {
    const locking = poolLockingBytecode(pool.ownerPkh);
    const tries = chained ? CHAINED_REREAD_ATTEMPTS : 1;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const live = (await this.deps.chain.getUtxos(locking))
        .map((utxo) => livePoolFromUtxo(pool.ownerPkhHex, pool.token.category, utxo))
        .find((candidate) => candidate?.outpoint === pool.outpoint);
      if (live !== undefined) return live;
      if (attempt + 1 < tries) await sleep(CHAINED_REREAD_DELAY_MS);
    }
    return undefined;
  }

  private async orderUtxo(row: OrderRow): Promise<Utxo | undefined> {
    const locking = orderLockingBytecode(paramsFromRow(row));
    const utxo = (await this.deps.chain.getUtxos(locking)).find(
      (candidate) => candidate.txid === row.funding_txid && candidate.vout === row.funding_vout,
    );
    if (utxo === undefined) return undefined;
    return {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      lockingBytecode: binToHex(locking),
      ...(utxo.token && {
        token: {
          category: utxo.token.category,
          amount: utxo.token.amount,
          ...(utxo.token.nft && {
            nft: { capability: utxo.token.nft.capability, commitment: utxo.token.nft.commitment },
          }),
        },
      }),
    };
  }

  private async insertAttempt(
    row: OrderRow,
    pool: LivePool,
    quote: PoolQuote,
    fee: bigint,
    chainedFrom: string | undefined,
    quoteAgeMs: number,
    outcome: 'built' | AttemptOutcome,
    extra: { txid?: string; hex?: string; reason?: string },
  ): Promise<string> {
    const { rows } = await this.deps.db.query<{ id: string }>(
      `INSERT INTO keeper_attempts
         (order_id, network, pool_outpoint, pool_owner_pkh, chained_from, candidate, quote_age_ms, outcome, failure_reason, txid, tx_hex,
          finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $8 = 'built' THEN NULL ELSE now() END)
       RETURNING id`,
      [
        row.id,
        this.deps.network,
        pool.outpoint,
        pool.ownerPkhHex,
        chainedFrom ?? null,
        JSON.stringify({
          supply: quote.supply.toString(),
          output: quote.output.toString(),
          recipientAmount: quote.recipientAmount.toString(),
          minOut: row.min_out,
          fee: fee.toString(),
          poolSats: pool.reserves.sats.toString(),
          poolTokens: pool.reserves.tokens.toString(),
        }),
        quoteAgeMs,
        outcome,
        extra.reason ?? null,
        extra.txid ?? null,
        extra.hex ?? null,
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('keeper_attempts insert returned no id');
    this.deps.analytics.emit('execution_attempted', {
      orderId: row.id,
      attemptId: id,
      outcome,
      poolOutpoint: pool.outpoint,
      chained: chainedFrom !== undefined,
    });
    return id;
  }

  private async finishAttempt(
    attemptId: string,
    outcome: AttemptOutcome,
    startedAt: number,
    fields: { reason?: string; results?: unknown; retryAfter?: Date },
  ): Promise<void> {
    await this.deps.db.query(
      `UPDATE keeper_attempts SET outcome = $2, failure_reason = $3, broadcast_results = $4, retry_after = $5,
         finished_at = now(), duration_ms = $6
       WHERE id = $1`,
      [
        attemptId,
        outcome,
        fields.reason ?? null,
        fields.results === undefined ? null : JSON.stringify(fields.results),
        fields.retryAfter ?? null,
        Date.now() - startedAt,
      ],
    );
  }

  private async noteAttempt(
    attemptId: string,
    orderId: string,
    outcome: AttemptOutcome,
    txid?: string,
  ): Promise<void> {
    await writeFact(this.deps.db, this.deps.network, FACT.lastAttempt, {
      attemptId,
      orderId,
      outcome,
      txid: txid ?? null,
    });
  }

  private async attempt(
    row: OrderRow,
    quote: PoolQuote,
    fee: bigint,
    chainedFrom: string | undefined,
    eventAt: Date,
  ): Promise<{ result: AttemptResult; nextPool?: LivePool }> {
    const startedAt = Date.now();
    const quotedAt = this.now().getTime();
    if (!(await this.claim(row.id))) return { result: { orderId: row.id, outcome: 'lease_held' } };
    try {
      const pool = await this.rereadPool(quote.pool, chainedFrom !== undefined);
      const record = async (outcome: AttemptOutcome, reason: string): Promise<{ result: AttemptResult }> => {
        const attemptId = await this.insertAttempt(
          row,
          quote.pool,
          quote,
          fee,
          chainedFrom,
          Date.now() - quotedAt,
          outcome,
          { reason },
        );
        await this.noteAttempt(attemptId, row.id, outcome);
        return { result: { orderId: row.id, outcome, attemptId, reason } };
      };
      if (pool === undefined)
        return await record('pool_changed', `pool ${quote.pool.outpoint} is no longer unspent`);

      const orderUtxo = await this.orderUtxo(row);
      if (orderUtxo === undefined) {
        const result = await record('order_spent', `order outpoint ${row.id} is spent`);
        await this.deps.onOrderSpent(row.id);
        return result;
      }

      const poolInput: CauldronPoolUtxo = {
        txid: pool.txid,
        vout: pool.vout,
        satoshis: pool.satoshis,
        token: pool.token,
        ownerPkh: pool.ownerPkh,
        lockingBytecode: binToHex(poolLockingBytecode(pool.ownerPkh)),
      };
      let built: ReturnType<typeof buildExecuteTransaction>;
      try {
        const order = instantiateOrder(paramsFromRow(row), this.deps.provider);
        built = buildExecuteTransaction(order, orderUtxo, poolInput, {
          fee: { kind: 'absolute', satoshis: fee },
        });
      } catch (error) {
        if (error instanceof OrderNotExecutableError) {
          return { result: { orderId: row.id, outcome: 'not_eligible', reason: error.reason } };
        }
        if (error instanceof InvalidPoolError)
          return await record('pool_changed', `${error.reason}: ${error.message}`);
        this.deps.logger.error(
          { err: error, orderId: row.id },
          'execute transaction failed local verification',
        );
        return await record('vm_rejected', describe(error));
      }

      const attemptId = await this.insertAttempt(
        row,
        pool,
        quote,
        fee,
        chainedFrom,
        Date.now() - quotedAt,
        'built',
        {
          txid: built.txid,
          hex: built.hex,
        },
      );
      const settled = await Promise.allSettled(
        this.deps.broadcasters.map((broadcaster) => broadcaster.broadcast(built.hex)),
      );
      const results = settled.map((outcome, index) => ({
        via: this.deps.broadcasters[index]?.name ?? 'unknown',
        ok: outcome.status === 'fulfilled',
        detail: outcome.status === 'fulfilled' ? outcome.value : describe(outcome.reason),
      }));
      const rejections = settled.flatMap((outcome) =>
        outcome.status === 'rejected'
          ? [
              outcome.reason instanceof BroadcastRejectedError
                ? outcome.reason.detail
                : describe(outcome.reason),
            ]
          : [],
      );
      const accepted = results.some((result) => result.ok) || rejections.some(isAlreadyKnownRejection);

      let outcome: AttemptOutcome;
      let reason: string | undefined;
      let retryAfter: Date | undefined;
      if (accepted) {
        outcome = 'broadcast_ok';
      } else if (rejections.some(isSpentInputRejection)) {
        const stillUnspent = await this.orderUtxo(row);
        outcome = stillUnspent === undefined ? 'order_spent' : 'pool_spent';
        reason = rejections.join(' | ');
      } else {
        outcome = 'broadcast_rejected';
        reason = rejections.join(' | ');
        const { rows: previous } = await this.deps.db.query<{ count: string }>(
          `SELECT count(*) AS count FROM keeper_attempts
            WHERE order_id = $1 AND outcome = 'broadcast_rejected'
              AND started_at > COALESCE((SELECT max(started_at) FROM keeper_attempts
                                          WHERE order_id = $1 AND outcome NOT IN ('broadcast_rejected', 'built')), 'epoch')`,
          [row.id],
        );
        retryAfter = new Date(this.now().getTime() + broadcastBackoffMs(Number(previous[0]?.count ?? 0) + 1));
      }
      await this.finishAttempt(attemptId, outcome, startedAt, {
        results,
        ...(reason !== undefined && { reason }),
        ...(retryAfter !== undefined && { retryAfter }),
      });
      await this.noteAttempt(attemptId, row.id, outcome, built.txid);
      if (outcome === 'order_spent') await this.deps.onOrderSpent(row.id);
      if (outcome !== 'broadcast_ok') {
        this.deps.logger.warn({ orderId: row.id, attemptId, outcome, reason }, 'keeper attempt failed');
        return {
          result: {
            orderId: row.id,
            outcome,
            attemptId,
            txid: built.txid,
            ...(reason !== undefined && { reason }),
          },
        };
      }
      await writeFact(this.deps.db, this.deps.network, FACT.lastBroadcast, {
        txid: built.txid,
        orderId: row.id,
        attemptId,
      });
      await writeFact(this.deps.db, this.deps.network, FACT.reactionLatency, {
        ms: Date.now() - eventAt.getTime(),
        orderId: row.id,
      });
      this.deps.logger.info({ orderId: row.id, attemptId, txid: built.txid }, 'execute broadcast accepted');
      const nextPool: LivePool = {
        txid: built.txid,
        vout: 0,
        satoshis: built.poolAfter.sats,
        token: { category: pool.token.category, amount: built.poolAfter.tokens },
        ownerPkh: pool.ownerPkh,
        lockingBytecode: binToHex(poolLockingBytecode(pool.ownerPkh)),
        outpoint: `${built.txid}:0`,
        ownerPkhHex: pool.ownerPkhHex,
        reserves: built.poolAfter,
        confirmed: false,
      };
      return { result: { orderId: row.id, outcome, attemptId, txid: built.txid }, nextPool };
    } finally {
      await this.release(row.id);
    }
  }

  /**
   * Settles attempts whose broadcast result is unknown or pending: a `built` row left by a crash and
   * `broadcast_ok` rows awaiting confirmation. At boot a missing transaction is `dropped` at once; in a
   * sweep it must be missing for two sweeps first.
   */
  async reconcileAttempts(mode: 'boot' | 'sweep'): Promise<number> {
    const { db, network, chain } = this.deps;
    const { rows } = await db.query<{
      id: string;
      order_id: string;
      outcome: string;
      txid: string | null;
      missing_sweeps: number;
      status: string | null;
    }>(
      `SELECT a.id, a.order_id, a.outcome, a.txid, a.missing_sweeps, o.status
         FROM keeper_attempts a LEFT JOIN orders o ON o.id = a.order_id
        WHERE a.network = $1 AND a.outcome IN ('built', 'broadcast_ok')
          AND (o.status IS NULL OR o.status IN ('OPEN', 'EXECUTION_PENDING', 'CANCELLATION_PENDING', 'RECONCILIATION_REQUIRED'))
          AND ($2 OR a.outcome = 'broadcast_ok' OR a.started_at < now() - interval '2 minutes')`,
      [network, mode === 'boot'],
    );
    let dropped = 0;
    for (const attempt of rows) {
      let present = false;
      if (attempt.txid !== null) {
        present = await chain.getTransactionStatus(attempt.txid).then(
          () => true,
          () => false,
        );
      }
      if (present) {
        await db.query(
          `UPDATE keeper_attempts SET outcome = 'broadcast_ok', missing_sweeps = 0, finished_at = COALESCE(finished_at, now()) WHERE id = $1`,
          [attempt.id],
        );
        continue;
      }
      const missing = attempt.missing_sweeps + 1;
      if (mode === 'boot' || missing >= 2) {
        await db.query(
          `UPDATE keeper_attempts SET outcome = 'dropped', missing_sweeps = $2, finished_at = now(),
             failure_reason = COALESCE(failure_reason, 'transaction not in mempool or chain') WHERE id = $1`,
          [attempt.id, missing],
        );
        await db.query('UPDATE orders SET claimed_by = NULL, claimed_until = NULL WHERE id = $1', [
          attempt.order_id,
        ]);
        dropped += 1;
      } else {
        await db.query('UPDATE keeper_attempts SET missing_sweeps = $2 WHERE id = $1', [attempt.id, missing]);
      }
    }
    return dropped;
  }
}
