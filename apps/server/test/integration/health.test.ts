import { hexToBin } from '@bitauth/libauth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { marketDomain, orderLockingBytecode, poolLockingBytecode, type OrderParams } from '@atprice/core';
import type { Db } from '../../src/db/pool.js';
import { FACT, poolFactName, writeFact } from '../../src/facts.js';
import { IndependentEvaluator } from '../../src/health/evaluator.js';
import { loadHealth } from '../../src/health/load.js';
import type { HealthVerdict } from '../../src/health/judge.js';
import { Executor } from '../../src/keeper/executor.js';
import { syncMarkets } from '../../src/markets.js';
import type { OrderRow } from '../../src/orders/model.js';
import { OrderObserver } from '../../src/orders/observe.js';
import { syncOrderAddress } from '../../src/orders/sync.js';
import { CORE_MATHS, bestPoolQuote, keeperExecuteFee, type PoolMaths } from '../../src/pools/quote.js';
import { readLivePools } from '../../src/pools/reader.js';
import { count, freshDb, silentLogger, testAnalytics } from '../support/db.js';
import { FakeChain } from '../support/fake-chain.js';
import {
  CAPTURED,
  TOKEN,
  buyParams,
  capturedLivePools,
  fundingTransaction,
  paymentTransaction,
  provider,
  seedPool,
} from '../support/orders.js';

// Architecture r5, "Health that cannot lie": every scenario runs the real executor, the real
// independent evaluator (ExchangeLab) and the real judge on pool state captured from chipnet.

const SWEEP_MS = 30_000;
const EVAL_MS = 30_000;
const BIG_POOL = CAPTURED.pools.reduce((a, b) => (BigInt(a.sats) > BigInt(b.sats) ? a : b));
const NOMINATION = [{ ownerPkh: BIG_POOL.ownerPkh, outpoint: 'seeded' }];

let db: Db;
let chain: FakeChain;
let observer: OrderObserver;
let clock: Date;

beforeAll(async () => {
  db = await freshDb();
  await syncMarkets(db, 'chipnet');
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE keeper_attempts, executions, transaction_events, orders, keeper_facts, evaluator_orders, evaluator_state',
  );
  chain = new FakeChain();
  observer = new OrderObserver(chain, 'chipnet', marketDomain('chipnet'));
  clock = new Date();
});

const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

const executor = (maths: PoolMaths = CORE_MATHS, nominate = async () => NOMINATION): Executor =>
  new Executor({
    db,
    network: 'chipnet',
    chain,
    provider,
    nominator: { nominate },
    broadcasters: [{ name: 'electrum', broadcast: (hex) => chain.broadcast(hex) }],
    keeperId: 'health-test',
    logger: silentLogger,
    analytics: testAnalytics,
    maths,
    now: () => clock,
    onOrderSpent: async () => undefined,
  });

const evaluator = (): IndependentEvaluator =>
  new IndependentEvaluator({
    db,
    network: 'chipnet',
    chain: {
      getTip: () => chain.getTip(),
      getUtxos: (locking) => chain.getUtxos(locking),
      endpointHost: 'independent.fake',
    },
    pools: async (tokenId) => (await readLivePools(chain, tokenId, NOMINATION)).pools,
    now: () => clock,
  });

interface StubOptions {
  /** Run the executor (a real keeper sweep). False is a keeper that only rewrites its timestamps. */
  readonly execute?: Executor | false;
  readonly subscriptionsOk?: boolean;
}

/** One keeper sweep at `clock`: optionally the real executor, then the facts a sweep writes. */
const keeperSweep = async ({
  execute = executor(),
  subscriptionsOk = true,
}: StubOptions = {}): Promise<void> => {
  if (execute === false) {
    await writeFact(db, 'chipnet', poolFactName(TOKEN), { pools: 1, source: 'stub' }, clock);
  } else {
    await execute.runToken(TOKEN, 'sweep').catch(() => undefined);
  }
  for (const row of (
    await db.query<OrderRow>(`SELECT * FROM orders WHERE status NOT IN ('FILLED', 'CANCELLED')`)
  ).rows) {
    await syncOrderAddress(
      db,
      observer,
      { ...paramsOf(row) },
      { sweep: true, reason: 'sweep', analytics: testAnalytics },
    );
  }
  await writeFact(
    db,
    'chipnet',
    FACT.header,
    { height: chain.tipHeight, hash: chain.blockHash(chain.tipHeight), server: 'fake' },
    clock,
  );
  await writeFact(
    db,
    'chipnet',
    FACT.subscriptions,
    { ok: subscriptionsOk, expected: 1, subscribed: subscriptionsOk ? 1 : 0, intentConnectionOk: true },
    clock,
  );
  await writeFact(
    db,
    'chipnet',
    FACT.sweep,
    { startedAt: clock.toISOString(), endedAt: clock.toISOString(), durationMs: 0 },
    clock,
  );
};

const paramsOf = (row: OrderRow): OrderParams => ({
  side: row.side,
  ownerPkh: hexToBin(row.owner_pkh),
  recipientLockingBytecode: hexToBin(row.recipient_locking_bytecode),
  tokenCategory: row.token_id,
  minOut: BigInt(row.min_out),
  maxNetworkFee: BigInt(row.max_network_fee),
  nonce: hexToBin(row.nonce),
});

const health = (): Promise<HealthVerdict> =>
  loadHealth(db, { network: 'chipnet', sweepIntervalMs: SWEEP_MS, evalIntervalMs: EVAL_MS }, clock);

/** Keeper sweep and evaluator run at the same instant, then the clock moves on by one interval. */
const cycle = async (options: StubOptions = {}): Promise<HealthVerdict> => {
  await keeperSweep(options);
  await evaluator().run();
  const verdict = await health();
  advance(SWEEP_MS);
  return verdict;
};

const openOrder = async (
  params: OrderParams,
  amount: bigint,
  confirmed = true,
): Promise<{ id: string; txid: string }> => {
  const txid = chain.add(fundingTransaction(params, amount), confirmed ? chain.tipHeight : null);
  await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
  return { id: `${txid}:0`, txid };
};

const status = async (id: string): Promise<string | undefined> =>
  (await db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id])).rows[0]?.status;

/** Tokens the captured big pool gives a 100,000-sat buy, from core maths. */
const quotedTokens = (spend: bigint): bigint => {
  const params = buyParams();
  const fee = keeperExecuteFee(params.maxNetworkFee);
  const pool = capturedLivePools().find((candidate) => candidate.ownerPkhHex === BIG_POOL.ownerPkh);
  if (pool === undefined) throw new Error('captured pool missing');
  const quote = bestPoolQuote(
    CORE_MATHS,
    { side: 'buy', satoshis: spend + 1000n + params.maxNetworkFee, tokenAmount: 0n },
    [pool],
    fee,
  );
  if (quote === undefined) throw new Error('no quote');
  return quote.recipientAmount;
};

describe('health with a working keeper', () => {
  it('is 200 ok when the keeper fills every executable order', async () => {
    seedPool(chain, BIG_POOL);
    const order = await openOrder(buyParams(), 100_000n);
    for (let round = 0; round < 4; round += 1) {
      const verdict = await cycle();
      expect(verdict.reasons).toEqual([]);
    }
    expect(await status(order.id)).toBe('EXECUTION_PENDING');
  });

  it('stays 200 for a token-carrying buy funding, a buy below the minimum and a token UTXO at a buy order address, with no keeper attempt', async () => {
    seedPool(chain, BIG_POOL);
    const tokenBuy = buyParams();
    chain.add(fundingTransaction(tokenBuy, 100_000n, { tokenOnBuy: 50n }), chain.tipHeight);
    await syncOrderAddress(db, observer, tokenBuy, {
      sweep: false,
      reason: 'test',
      analytics: testAnalytics,
    });
    const smallBuy = buyParams();
    chain.add(fundingTransaction(smallBuy, 49_999n), chain.tipHeight);
    await syncOrderAddress(db, observer, smallBuy, {
      sweep: false,
      reason: 'test',
      analytics: testAnalytics,
    });
    const outOfRange = buyParams({ minOut: 10n ** 15n });
    await openOrder(outOfRange, 100_000n);
    chain.add(paymentTransaction(orderLockingBytecode(outOfRange), 1_000n, 25n), chain.tipHeight);
    await syncOrderAddress(db, observer, outOfRange, {
      sweep: false,
      reason: 'test',
      analytics: testAnalytics,
    });

    const reasons = await db.query<{ unsupported_reason: string | null; supported: boolean }>(
      'SELECT supported, unsupported_reason FROM orders ORDER BY unsupported_reason NULLS FIRST',
    );
    expect(reasons.rows.map((row) => row.unsupported_reason)).toEqual([
      null,
      'amount_below_minimum',
      'funding_mismatch',
      'funding_mismatch',
    ]);

    for (let round = 0; round < 5; round += 1) {
      const verdict = await cycle();
      expect(verdict.status).toBe('ok');
    }
    expect(await count(db, 'SELECT count(*) FROM keeper_attempts')).toBe(0);
    expect(await count(db, 'SELECT count(*) FROM evaluator_orders')).toBe(1);
  });
});

describe('health that cannot lie (each case must answer 503 with the right reason)', () => {
  it('keeper never started', async () => {
    seedPool(chain, BIG_POOL);
    await openOrder(buyParams(), 100_000n);
    let verdict = await health();
    for (let round = 0; round < 4; round += 1) {
      await evaluator().run();
      verdict = await health();
      advance(EVAL_MS + 1);
    }
    expect(verdict.status).toBe('degraded');
    expect(verdict.reasons).toEqual([
      'tip_lag',
      'sweep_stale',
      'pool_data_stale',
      'subscriptions_incomplete',
      'executable_unfilled',
    ]);
  });

  it('keeper running but every broadcast rejected', async () => {
    seedPool(chain, BIG_POOL);
    const order = await openOrder(buyParams(), 100_000n);
    chain.rejectBroadcastWith =
      'non-mandatory-script-verify-flag (Signature must be zero for failed CHECK(MULTI)SIG operation)';
    const verdicts: HealthVerdict[] = [];
    for (let round = 0; round < 5; round += 1) verdicts.push(await cycle());
    expect(verdicts[0]?.status).toBe('ok');
    expect(verdicts.at(-1)?.reasons).toEqual(['executable_unfilled']);
    expect(await status(order.id)).toBe('OPEN');
    expect(
      await count(db, `SELECT count(*) FROM keeper_attempts WHERE outcome = 'broadcast_rejected'`),
    ).toBeGreaterThan(0);
  });

  it('pool data stale', async () => {
    seedPool(chain, BIG_POOL);
    const failing = executor(CORE_MATHS, async () => {
      throw new Error('indexer unreachable');
    });
    await cycle();
    advance(2 * 60_000);
    const verdict = await cycle({ execute: failing });
    expect(verdict.reasons).toEqual(['pool_data_stale']);
  });

  it('keeper killed mid-run', async () => {
    seedPool(chain, BIG_POOL);
    await openOrder(buyParams(), 100_000n);
    chain.rejectBroadcastWith = 'mempool full';
    await cycle();
    await writeFact(db, 'chipnet', FACT.sweepStarted, { startedAt: clock.toISOString() }, clock);
    let verdict = await health();
    for (let round = 0; round < 4; round += 1) {
      advance(EVAL_MS);
      await evaluator().run();
      verdict = await health();
    }
    expect(verdict.status).toBe('degraded');
    expect(verdict.reasons).toEqual(
      expect.arrayContaining(['sweep_stale', 'subscriptions_incomplete', 'executable_unfilled']),
    );
  });

  it('subscriptions dropped', async () => {
    seedPool(chain, BIG_POOL);
    expect((await cycle()).status).toBe('ok');
    const verdict = await cycle({ subscriptionsOk: false });
    expect(verdict.reasons).toEqual(['subscriptions_incomplete']);
  });

  it('a mutation that breaks the core quote is caught as quote_disagreement', async () => {
    seedPool(chain, BIG_POOL);
    await openOrder(buyParams({ minOut: 10n ** 15n }), 100_000n);
    expect((await cycle()).reasons).toEqual([]);

    const mutated: PoolMaths = {
      buy: (reserves, bchIn) => CORE_MATHS.buy(reserves, bchIn) + 1n,
      sell: (reserves, tokensIn) => CORE_MATHS.sell(reserves, tokensIn) + 1n,
    };
    const verdict = await cycle({ execute: executor(mutated) });
    expect(verdict.reasons).toEqual(['quote_disagreement']);
    const { rows } = await db.query<{ quote_disagreement: { keeper: string; evaluator: string } }>(
      'SELECT quote_disagreement FROM evaluator_orders WHERE quote_disagreement IS NOT NULL',
    );
    expect(
      BigInt(rows[0]?.quote_disagreement.keeper ?? 0) - BigInt(rows[0]?.quote_disagreement.evaluator ?? 0),
    ).toBe(1n);
  });

  it('a keeper stub that rewrites its own timestamps every sweep and never fills', async () => {
    seedPool(chain, BIG_POOL);
    await openOrder(buyParams(), 100_000n);
    const verdicts: HealthVerdict[] = [];
    for (let round = 0; round < 5; round += 1) verdicts.push(await cycle({ execute: false }));
    expect(verdicts[0]?.status).toBe('ok');
    expect(verdicts.at(-1)?.reasons).toEqual(['executable_unfilled']);
    expect(await count(db, 'SELECT count(*) FROM keeper_attempts')).toBe(0);
  });

  it('an order stuck in FUNDING_PENDING with confirmed funding and an executable pool', async () => {
    seedPool(chain, BIG_POOL);
    const params = buyParams();
    const order = await openOrder(params, 100_000n, false);
    expect(await status(order.id)).toBe('FUNDING_PENDING');
    chain.confirm(order.txid, chain.tipHeight);
    // The keeper never learns of the confirmation: its sweep runs the executor but no indexer resync.
    const verdicts: HealthVerdict[] = [];
    for (let round = 0; round < 5; round += 1) {
      await executor().runToken(TOKEN, 'sweep');
      await writeFact(db, 'chipnet', FACT.header, { height: chain.tipHeight, server: 'fake' }, clock);
      await writeFact(db, 'chipnet', FACT.subscriptions, { ok: true }, clock);
      await writeFact(db, 'chipnet', FACT.sweep, { startedAt: clock.toISOString() }, clock);
      await evaluator().run();
      verdicts.push(await health());
      advance(SWEEP_MS);
    }
    expect(await status(order.id)).toBe('FUNDING_PENDING');
    expect(verdicts[0]?.status).toBe('ok');
    expect(verdicts.at(-1)?.reasons).toEqual(['executable_unfilled']);
  });

  it('an evaluator defect (a non-liquidity ExchangeLab error) is evaluator_unavailable, never a silent ok', async () => {
    // #given a healthy cycle, then pools whose reserves reach the evaluator with the wrong type
    seedPool(chain, BIG_POOL);
    await openOrder(buyParams({ minOut: quotedTokens(100_000n) * 3n }), 100_000n);
    expect((await cycle()).status).toBe('ok');
    const broken = new IndependentEvaluator({
      db,
      network: 'chipnet',
      chain: {
        getTip: () => chain.getTip(),
        getUtxos: (locking) => chain.getUtxos(locking),
        endpointHost: 'independent.fake',
      },
      pools: async (tokenId) =>
        (await readLivePools(chain, tokenId, NOMINATION)).pools.map((pool) => ({
          ...pool,
          reserves: { ...pool.reserves, sats: Number(pool.reserves.sats) as unknown as bigint },
        })),
      now: () => clock,
    });
    // #when
    await keeperSweep();
    await expect(broken.run()).rejects.toThrow(TypeError);
    const verdict = await health();
    // #then
    expect(verdict.status).toBe('degraded');
    expect(verdict.reasons).toEqual(['evaluator_unavailable']);
  });

  it("an evaluator on the keeper's own Electrum server cannot vouch for the keeper", async () => {
    seedPool(chain, BIG_POOL);
    await keeperSweep();
    await new IndependentEvaluator({
      db,
      network: 'chipnet',
      chain: {
        getTip: () => chain.getTip(),
        getUtxos: (locking) => chain.getUtxos(locking),
        endpointHost: 'fake',
      },
      pools: async (tokenId) => (await readLivePools(chain, tokenId, NOMINATION)).pools,
      now: () => clock,
    }).run();
    expect((await health()).reasons).toEqual(['tip_lag']);
  });

  it('an order returning to range after a long out-of-range period is not 503 within one sweep', async () => {
    const pool = seedPool(chain, BIG_POOL);
    const reachable = quotedTokens(100_000n);
    const order = await openOrder(buyParams({ minOut: reachable * 3n }), 100_000n);
    // Out of range for an hour of evaluator runs, with a keeper that never needs to act.
    for (let round = 0; round < 120; round += 1) {
      await keeperSweep();
      await evaluator().run();
      advance(SWEEP_MS);
    }
    expect((await health()).status).toBe('ok');

    // Someone sells a large amount of tokens into the pool: the price moves and the order is in range.
    chain.add(
      {
        version: 2,
        locktime: 0,
        inputs: [
          {
            outpointTransactionHash: hexToBin(pool.txid),
            outpointIndex: 0,
            sequenceNumber: 0,
            unlockingBytecode: new Uint8Array(),
          },
        ],
        outputs: [
          {
            lockingBytecode: poolLockingBytecode(hexToBin(BIG_POOL.ownerPkh)),
            valueSatoshis: BigInt(BIG_POOL.sats) / 4n,
            token: { category: hexToBin(TOKEN), amount: BigInt(BIG_POOL.tokens) * 4n },
          },
        ],
      },
      null,
    );
    await evaluator().run();
    const { rows } = await db.query<{ executable_since: Date }>(
      'SELECT executable_since FROM evaluator_orders WHERE order_id = $1',
      [order.id],
    );
    expect(rows[0]?.executable_since.getTime()).toBe(clock.getTime());
    expect((await health()).reasons).toEqual([]);

    advance(SWEEP_MS);
    const verdict = await cycle();
    expect(verdict.reasons).toEqual([]);
    expect(await status(order.id)).toBe('EXECUTION_PENDING');
    await evaluator().run();
    expect(await count(db, 'SELECT count(*) FROM evaluator_orders WHERE executable_since IS NOT NULL')).toBe(
      0,
    );
  });
});
