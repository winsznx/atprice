import { hexToBin, decodeTransactionBch, binToHex } from '@bitauth/libauth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { marketDomain, poolLockingBytecode, type OrderParams } from '@atprice/core';
import type { Db } from '../../src/db/pool.js';
import {
  Executor,
  broadcastBackoffMs,
  type Broadcaster,
  type ExecutorDeps,
} from '../../src/keeper/executor.js';
import { loadHealth } from '../../src/health/load.js';
import { syncMarkets } from '../../src/markets.js';
import type { OrderRow } from '../../src/orders/model.js';
import { OrderObserver } from '../../src/orders/observe.js';
import { syncOrderAddress } from '../../src/orders/sync.js';
import { count, freshDb, silentLogger, testAnalytics } from '../support/db.js';
import { FakeChain } from '../support/fake-chain.js';
import {
  CAPTURED,
  TOKEN,
  buyParams,
  cancelHex,
  fundingTransaction,
  provider,
  seedPool,
} from '../support/orders.js';

let db: Db;
let chain: FakeChain;
let observer: OrderObserver;
let spent: string[];

const BIG_POOL = CAPTURED.pools.reduce((a, b) => (BigInt(a.sats) > BigInt(b.sats) ? a : b));

beforeAll(async () => {
  db = await freshDb();
  await syncMarkets(db, 'chipnet');
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('TRUNCATE keeper_attempts, executions, transaction_events, orders');
  chain = new FakeChain();
  observer = new OrderObserver(chain, 'chipnet', marketDomain('chipnet'));
  spent = [];
});

const executor = (overrides: Partial<ExecutorDeps> = {}): Executor =>
  new Executor({
    db,
    network: 'chipnet',
    chain,
    provider,
    nominator: { nominate: async () => [{ ownerPkh: BIG_POOL.ownerPkh, outpoint: 'seeded' }] },
    broadcasters: [{ name: 'electrum', broadcast: (hex) => chain.broadcast(hex) }],
    keeperId: 'test-keeper',
    logger: silentLogger,
    analytics: testAnalytics,
    onOrderSpent: async (orderId) => {
      spent.push(orderId);
    },
    ...overrides,
  });

const openOrder = async (
  params: OrderParams,
  amount: bigint,
  height = 342_301,
): Promise<{ id: string; txid: string; params: OrderParams }> => {
  const funding = fundingTransaction(params, amount);
  const txid = chain.add(funding, height);
  await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
  return { id: `${txid}:0`, txid, params };
};

const status = async (id: string): Promise<string | undefined> =>
  (await db.query<OrderRow>('SELECT status FROM orders WHERE id = $1', [id])).rows[0]?.status;

const inputsOf = (hex: string): string[] => {
  const tx = decodeTransactionBch(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(tx);
  return tx.inputs.map((input) => `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`);
};

describe('executor', () => {
  it("fills two executable orders on one pool within one run, the second built on the first fill's pool output", async () => {
    const pool = seedPool(chain, BIG_POOL);
    const first = await openOrder(buyParams(), 100_000n, 342_301);
    const second = await openOrder(buyParams(), 120_000n, 342_302);
    const summary = await executor().runToken(TOKEN, 'test');
    expect(summary.attempts.map((attempt) => attempt.outcome)).toEqual(['broadcast_ok', 'broadcast_ok']);
    const [firstHex, secondHex] = chain.broadcasts;
    if (firstHex === undefined || secondHex === undefined) throw new Error('expected two broadcasts');
    expect(inputsOf(firstHex)[0]).toBe(pool.outpoint);
    expect(inputsOf(secondHex)[0]).toBe(`${summary.attempts[0]?.txid}:0`);
    const { rows } = await db.query<{ chained_from: string | null; id: string }>(
      'SELECT id, chained_from FROM keeper_attempts ORDER BY started_at',
    );
    expect(rows[1]?.chained_from).toBe(rows[0]?.id);
    const emitted = testAnalytics.events
      .filter((entry) => entry.fields.orderId === first.id)
      .map((entry) => entry.event);
    expect(emitted).toEqual(
      expect.arrayContaining([
        'funding_confirmed',
        'order_opened',
        'execution_eligible',
        'execution_attempted',
      ]),
    );
    for (const order of [first, second]) {
      await syncOrderAddress(db, observer, order.params, {
        sweep: false,
        reason: 'test',
        analytics: testAnalytics,
      });
    }
    expect(await status(first.id)).toBe('EXECUTION_PENDING');
    expect(await status(second.id)).toBe('EXECUTION_PENDING');
  });

  it('records the keeper evaluation (pool outpoint, supply, output) and does nothing for an order outside its limit', async () => {
    seedPool(chain, BIG_POOL);
    const order = await openOrder(buyParams({ minOut: 10n ** 15n }), 100_000n);
    const summary = await executor().runToken(TOKEN, 'test');
    expect(summary.attempts).toEqual([]);
    const { rows } = await db.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [order.id]);
    expect(rows[0]?.last_evaluation).toMatchObject({ executable: false, poolOwnerPkh: BIG_POOL.ownerPkh });
    expect(rows[0]?.keeper_executable_since).toBeNull();
    expect(await count(db, 'SELECT count(*) FROM keeper_attempts')).toBe(0);
  });

  it('retries on the new pool UTXO after a third party spends the pool between build and broadcast', async () => {
    const pool = seedPool(chain, BIG_POOL);
    const order = await openOrder(buyParams(), 100_000n);
    let raced = false;
    const racing: Broadcaster = {
      name: 'electrum',
      broadcast: async (hex) => {
        if (!raced) {
          raced = true;
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
                  valueSatoshis: BigInt(BIG_POOL.sats) + 5_000_000n,
                  token: { category: hexToBin(TOKEN), amount: BigInt(BIG_POOL.tokens) - 100n },
                },
              ],
            },
            null,
          );
        }
        return chain.broadcast(hex);
      },
    };
    const keeper = executor({ broadcasters: [racing] });
    const first = await keeper.runToken(TOKEN, 'test');
    expect(first.attempts.map((attempt) => attempt.outcome)).toEqual(['pool_spent']);
    const second = await keeper.runToken(TOKEN, 'pool_event');
    expect(second.attempts.map((attempt) => attempt.outcome)).toEqual(['broadcast_ok']);
    const retried = chain.broadcasts.at(-1);
    expect(retried).toBeDefined();
    expect(inputsOf(retried ?? '')[0]).not.toBe(pool.outpoint);
    expect(inputsOf(retried ?? '')[1]).toBe(order.id);
  });

  it('backs off after a node rejection and does not retry before retry_after', async () => {
    seedPool(chain, BIG_POOL);
    await openOrder(buyParams(), 100_000n);
    chain.rejectBroadcastWith = 'mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation)';
    const keeper = executor();
    const started = Date.now();
    const first = await keeper.runToken(TOKEN, 'test');
    expect(first.attempts[0]).toMatchObject({ outcome: 'broadcast_rejected' });
    const { rows } = await db.query<{ retry_after: Date; failure_reason: string }>(
      'SELECT retry_after, failure_reason FROM keeper_attempts',
    );
    expect(rows[0]?.failure_reason).toContain('mandatory-script-verify-flag-failed');
    expect((rows[0]?.retry_after.getTime() ?? 0) - started).toBeGreaterThanOrEqual(
      broadcastBackoffMs(1) - 1_000,
    );
    const second = await keeper.runToken(TOKEN, 'test');
    expect(second.attempts).toEqual([]);
    expect(broadcastBackoffMs(2)).toBe(60_000);
    expect(broadcastBackoffMs(20)).toBe(30 * 60_000);
  });

  it('records order_spent and asks for a resync when the order outpoint is already spent', async () => {
    seedPool(chain, BIG_POOL);
    const params = buyParams();
    const funding = fundingTransaction(params, 100_000n);
    const txid = chain.add(funding, 342_301);
    await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
    chain.addHex(cancelHex(params, txid, funding));
    const summary = await executor().runToken(TOKEN, 'test');
    expect(summary.attempts[0]).toMatchObject({ outcome: 'order_spent' });
    expect(spent).toEqual([`${txid}:0`]);
  });

  it('skips an order whose lease another keeper holds', async () => {
    seedPool(chain, BIG_POOL);
    const order = await openOrder(buyParams(), 100_000n);
    await db.query(
      `UPDATE orders SET claimed_by = 'other', claimed_until = now() + interval '1 minute' WHERE id = $1`,
      [order.id],
    );
    const summary = await executor().runToken(TOKEN, 'test');
    expect(summary.attempts).toEqual([{ orderId: order.id, outcome: 'lease_held' }]);
    expect(chain.broadcasts).toHaveLength(0);
  });

  it('takes over an order whose lease expired (a crashed keeper never holds an order)', async () => {
    seedPool(chain, BIG_POOL);
    const order = await openOrder(buyParams(), 100_000n);
    await db.query(
      `UPDATE orders SET claimed_by = 'crashed', claimed_until = now() - interval '1 second' WHERE id = $1`,
      [order.id],
    );
    const summary = await executor().runToken(TOKEN, 'test');
    expect(summary.attempts.map((attempt) => attempt.outcome)).toEqual(['broadcast_ok']);
  });

  it('commits the lease before any network I/O and releases it after the broadcast result', async () => {
    seedPool(chain, BIG_POOL);
    const order = await openOrder(buyParams(), 100_000n);
    const seen: { claimedBy: string | null; attempt: string | undefined }[] = [];
    const observing: Broadcaster = {
      name: 'electrum',
      broadcast: async (hex) => {
        const { rows } = await db.query<{ claimed_by: string | null }>(
          'SELECT claimed_by FROM orders WHERE id = $1',
          [order.id],
        );
        const attempt = await db.query<{ outcome: string }>(
          'SELECT outcome FROM keeper_attempts WHERE order_id = $1',
          [order.id],
        );
        seen.push({ claimedBy: rows[0]?.claimed_by ?? null, attempt: attempt.rows[0]?.outcome });
        return chain.broadcast(hex);
      },
    };
    await executor({ broadcasters: [observing] }).runToken(TOKEN, 'test');
    expect(seen).toEqual([{ claimedBy: 'test-keeper', attempt: 'built' }]);
    const { rows } = await db.query<{ claimed_by: string | null; claimed_until: Date | null }>(
      'SELECT claimed_by, claimed_until FROM orders WHERE id = $1',
      [order.id],
    );
    expect(rows[0]).toEqual({ claimed_by: null, claimed_until: null });
  });

  it('lets only one of two keepers claim the same order', async () => {
    seedPool(chain, BIG_POOL);
    const order = await openOrder(buyParams(), 100_000n);
    const a = executor({ keeperId: 'keeper-a' });
    const b = executor({ keeperId: 'keeper-b' });
    const [first, second] = await Promise.all([a.runToken(TOKEN, 'test'), b.runToken(TOKEN, 'test')]);
    const outcomes = [...first.attempts, ...second.attempts].map((attempt) => attempt.outcome).sort();
    expect(outcomes.filter((outcome) => outcome === 'broadcast_ok')).toHaveLength(1);
    expect(chain.broadcasts).toHaveLength(1);
    expect(
      await count(
        db,
        `SELECT count(*) FROM keeper_attempts WHERE order_id = $1 AND outcome = 'broadcast_ok'`,
        [order.id],
      ),
    ).toBe(1);
  });

  it('never retries an order with a vm_rejected attempt, and health reports it while the order is OPEN', async () => {
    seedPool(chain, BIG_POOL);
    const order = await openOrder(buyParams(), 100_000n);
    await db.query(
      `INSERT INTO keeper_attempts (order_id, network, candidate, quote_age_ms, outcome, failure_reason, finished_at)
       VALUES ($1, 'chipnet', '{}', 0, 'vm_rejected', 'vm_rejected: test defect', now())`,
      [order.id],
    );
    const summary = await executor().runToken(TOKEN, 'test');
    expect(summary).toMatchObject({ executable: 1, attempts: [] });
    expect(chain.broadcasts).toHaveLength(0);
    const verdict = await loadHealth(db, {
      network: 'chipnet',
      sweepIntervalMs: 30_000,
      evalIntervalMs: 30_000,
    });
    expect(verdict.reasons).toContain('vm_rejected');
  });

  it('marks a broadcast that vanished from the mempool as dropped after two sweeps, and at once at boot', async () => {
    seedPool(chain, BIG_POOL);
    await openOrder(buyParams(), 100_000n);
    const keeper = executor();
    const summary = await keeper.runToken(TOKEN, 'test');
    const txid = summary.attempts[0]?.txid ?? '';
    chain.drop(txid);
    expect(await keeper.reconcileAttempts('sweep')).toBe(0);
    expect(await keeper.reconcileAttempts('sweep')).toBe(1);
    expect(await count(db, `SELECT count(*) FROM keeper_attempts WHERE outcome = 'dropped'`)).toBe(1);

    await db.query(`UPDATE keeper_attempts SET outcome = 'broadcast_ok', missing_sweeps = 0`);
    expect(await keeper.reconcileAttempts('boot')).toBe(1);
  });
});
