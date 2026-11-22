import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { marketDomain, orderLockingBytecode, type OrderParams } from '@atprice/core';
import type { Db } from '../../src/db/pool.js';
import type { OrderRow } from '../../src/orders/model.js';
import { OrderObserver } from '../../src/orders/observe.js';
import { markReorgedExecutions, recordObservation } from '../../src/orders/record.js';
import { syncOrderAddress } from '../../src/orders/sync.js';
import { count, freshDb, testAnalytics } from '../support/db.js';
import { FakeChain } from '../support/fake-chain.js';
import {
  CAPTURED,
  buyParams,
  cancelHex,
  executeHex,
  fundingTransaction,
  paymentTransaction,
  seedPool,
  sellParams,
} from '../support/orders.js';

let db: Db;
let chain: FakeChain;
let observer: OrderObserver;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(() => {
  chain = new FakeChain();
  observer = new OrderObserver(chain, 'chipnet', marketDomain('chipnet'));
});

const sync = (params: OrderParams, sweep = false) =>
  syncOrderAddress(db, observer, params, { sweep, reason: 'test', analytics: testAnalytics });
const order = async (id: string): Promise<OrderRow | undefined> =>
  (await db.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
const events = async (id: string) =>
  (
    await db.query<{ cause: string; decision: string; from_status: string | null; to_status: string | null }>(
      'SELECT cause, decision, from_status, to_status FROM transaction_events WHERE order_id = $1 ORDER BY id',
      [id],
    )
  ).rows;

const BIG_POOL = CAPTURED.pools.reduce((a, b) => (BigInt(a.sats) > BigInt(b.sats) ? a : b));

describe('order observation through the one transition path', () => {
  it('creates FUNDING_PENDING from mempool funding, then OPEN on confirmation', async () => {
    const params = buyParams();
    const funding = fundingTransaction(params, 60_000n);
    const txid = chain.add(funding);
    await sync(params);
    expect((await order(`${txid}:0`))?.status).toBe('FUNDING_PENDING');
    chain.confirm(txid, 342_301);
    await sync(params);
    const row = await order(`${txid}:0`);
    expect(row?.status).toBe('OPEN');
    expect(row?.funding_height).toBe(342_301);
    expect(row?.supported).toBe(true);
    expect(row?.input_amount).toBe('60000');
    expect((await events(`${txid}:0`)).map((event) => event.cause)).toEqual([
      'funding_seen',
      'funding_confirmed',
    ]);
  });

  it('treats repeated observations of the same state as no-ops that still write an event', async () => {
    const params = buyParams();
    const txid = chain.add(fundingTransaction(params, 60_000n), 342_301);
    await sync(params);
    await sync(params);
    await sync(params);
    const log = await events(`${txid}:0`);
    expect(log.map((event) => event.decision)).toEqual(['transition', 'noop', 'noop']);
    expect((await order(`${txid}:0`))?.status).toBe('OPEN');
  });

  it('follows FUNDING_PENDING -> CANCELLATION_PENDING -> CANCELLED when the owner cancels before funding confirms', async () => {
    const params = buyParams();
    const funding = fundingTransaction(params, 60_000n);
    const fundingTxid = chain.add(funding);
    await sync(params);
    const cancelTxid = chain.addHex(cancelHex(params, fundingTxid, funding));
    await sync(params);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('CANCELLATION_PENDING');
    chain.confirm(fundingTxid, 342_301);
    chain.confirm(cancelTxid, 342_301);
    await sync(params);
    const row = await order(`${fundingTxid}:0`);
    expect(row?.status).toBe('CANCELLED');
    expect(row?.spend_kind).toBe('cancel');
    expect(
      (await events(`${fundingTxid}:0`)).map((event) => `${event.from_status ?? '-'}>${event.to_status}`),
    ).toEqual([
      '->FUNDING_PENDING',
      'FUNDING_PENDING>CANCELLATION_PENDING',
      'CANCELLATION_PENDING>CANCELLED',
    ]);
  });

  it('records the funding block of an order already in a pending state as a no-op', async () => {
    const params = buyParams();
    const funding = fundingTransaction(params, 60_000n);
    const fundingTxid = chain.add(funding);
    await sync(params);
    chain.addHex(cancelHex(params, fundingTxid, funding));
    await sync(params);
    chain.confirm(fundingTxid, 342_301);
    await sync(params);
    const log = await events(`${fundingTxid}:0`);
    expect(log.at(-1)).toMatchObject({
      decision: 'noop',
      from_status: 'CANCELLATION_PENDING',
      to_status: 'CANCELLATION_PENDING',
    });
    expect((await order(`${fundingTxid}:0`))?.funding_height).toBe(342_301);
  });

  it('handles funding confirmed in an earlier block than the cancel', async () => {
    const params = buyParams();
    const funding = fundingTransaction(params, 60_000n);
    const fundingTxid = chain.add(funding, 342_301);
    await sync(params);
    const cancelTxid = chain.addHex(cancelHex(params, fundingTxid, funding));
    await sync(params);
    chain.confirm(cancelTxid, 342_305);
    await sync(params);
    expect((await events(`${fundingTxid}:0`)).map((event) => event.to_status)).toEqual([
      'OPEN',
      'CANCELLATION_PENDING',
      'CANCELLED',
    ]);
  });

  it('records a third-party execute as an execution derived from the observed transaction', async () => {
    const params = buyParams();
    const funding = fundingTransaction(params, 100_000n);
    const fundingTxid = chain.add(funding, 342_301);
    const pool = seedPool(chain, BIG_POOL);
    await sync(params);
    const executeTxid = chain.addHex(
      executeHex(params, fundingTxid, funding, {
        txid: pool.txid,
        vout: 0,
        ownerPkh: BIG_POOL.ownerPkh,
        sats: BigInt(BIG_POOL.sats),
        tokens: BigInt(BIG_POOL.tokens),
      }),
    );
    await sync(params);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('EXECUTION_PENDING');
    chain.confirm(executeTxid, 342_302);
    await sync(params);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('FILLED');
    const { rows } = await db.query<{
      status: string;
      output_amount: string;
      by_atprice_keeper: boolean;
      route_metadata: { poolOwnerPkh: string };
    }>('SELECT status, output_amount, by_atprice_keeper, route_metadata FROM executions WHERE txid = $1', [
      executeTxid,
    ]);
    expect(rows[0]).toMatchObject({ status: 'confirmed', by_atprice_keeper: false });
    expect(rows[0]?.route_metadata.poolOwnerPkh).toBe(BIG_POOL.ownerPkh);
    expect(BigInt(rows[0]?.output_amount ?? '0')).toBeGreaterThanOrEqual(params.minOut);
  });

  it('moves an order spent by an unknown script path to RECONCILIATION_REQUIRED', async () => {
    const params = buyParams();
    const funding = fundingTransaction(params, 60_000n);
    const fundingTxid = chain.add(funding, 342_301);
    await sync(params);
    const fundingHash = Uint8Array.from(Buffer.from(fundingTxid, 'hex'));
    chain.add(
      {
        version: 2,
        locktime: 0,
        inputs: [
          {
            outpointTransactionHash: fundingHash,
            outpointIndex: 0,
            sequenceNumber: 0,
            unlockingBytecode: Uint8Array.of(0x51),
          },
        ],
        outputs: [{ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n }],
      },
      null,
    );
    await sync(params);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('RECONCILIATION_REQUIRED');
    expect((await events(`${fundingTxid}:0`)).at(-1)?.cause).toBe('unknown_spend');
  });

  it('reverts a pending spend to OPEN only after it has been gone for two sweeps', async () => {
    const params = buyParams();
    const funding = fundingTransaction(params, 60_000n);
    const fundingTxid = chain.add(funding, 342_301);
    await sync(params);
    const cancelTxid = chain.addHex(cancelHex(params, fundingTxid, funding));
    await sync(params);
    chain.drop(cancelTxid);
    await sync(params, false);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('CANCELLATION_PENDING');
    await sync(params, true);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('CANCELLATION_PENDING');
    await sync(params, true);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('OPEN');
    expect((await events(`${fundingTxid}:0`)).at(-1)?.cause).toBe('spend_vanished');
  });

  it('deletes a FUNDING_PENDING order whose funding vanished for two sweeps and keeps its events', async () => {
    const params = buyParams();
    const fundingTxid = chain.add(fundingTransaction(params, 60_000n));
    await sync(params);
    chain.drop(fundingTxid);
    await sync(params, true);
    expect(await order(`${fundingTxid}:0`)).toBeDefined();
    await sync(params, true);
    expect(await order(`${fundingTxid}:0`)).toBeUndefined();
    expect((await events(`${fundingTxid}:0`)).at(-1)).toMatchObject({
      decision: 'delete',
      to_status: 'DELETED',
    });
  });

  it('moves a confirmed order whose funding disappears to RECONCILIATION_REQUIRED, never silently away', async () => {
    const params = buyParams();
    const fundingTxid = chain.add(fundingTransaction(params, 60_000n), 342_301);
    await sync(params);
    chain.drop(fundingTxid);
    await sync(params, true);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('RECONCILIATION_REQUIRED');
  });

  it('resyncs a RECONCILIATION_REQUIRED order to the state chain derives, with resync as the cause', async () => {
    const params = buyParams();
    const fundingTxid = chain.add(fundingTransaction(params, 60_000n), 342_301);
    await sync(params);
    await recordObservation(db, {
      orderId: `${fundingTxid}:0`,
      network: 'chipnet',
      facts: { funding: 'confirmed', spend: { kind: 'none' } },
      funding: undefined,
      spend: undefined,
      forced: { derived: 'RECONCILIATION_REQUIRED', cause: 'reorg', detail: 'test reorg' },
      sweep: false,
    });
    expect((await order(`${fundingTxid}:0`))?.status).toBe('RECONCILIATION_REQUIRED');
    await sync(params);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('OPEN');
    expect((await events(`${fundingTxid}:0`)).at(-1)?.cause).toBe('resync');
  });

  it('creates an order found already filled by backfill directly in FILLED', async () => {
    const params = sellParams();
    const funding = fundingTransaction(params, 50n);
    const fundingTxid = chain.add(funding, 342_301);
    const pool = seedPool(chain, BIG_POOL);
    chain.addHex(
      executeHex(params, fundingTxid, funding, {
        txid: pool.txid,
        vout: 0,
        ownerPkh: BIG_POOL.ownerPkh,
        sats: BigInt(BIG_POOL.sats),
        tokens: BigInt(BIG_POOL.tokens),
      }),
      342_302,
    );
    await sync(params);
    expect((await order(`${fundingTxid}:0`))?.status).toBe('FILLED');
    expect((await events(`${fundingTxid}:0`))[0]).toMatchObject({
      cause: 'backfill',
      from_status: null,
      to_status: 'FILLED',
    });
  });
});

describe('observations from a server behind the recorded chain (backend r2 blocker 1)', () => {
  const executionRow = async (txid: string) =>
    (
      await db.query<{ status: string; block_height: number | null; block_hash: string | null }>(
        'SELECT status, block_height, block_hash FROM executions WHERE txid = $1',
        [txid],
      )
    ).rows[0];

  /** A filled buy recorded from `chain`, plus a second server holding the same transactions. */
  const recordFilled = async () => {
    const params = buyParams();
    const funding = fundingTransaction(params, 100_000n);
    const fundingTxid = chain.add(funding, 342_297);
    const pool = seedPool(chain, BIG_POOL);
    const executeRaw = executeHex(params, fundingTxid, funding, {
      txid: pool.txid,
      vout: 0,
      ownerPkh: BIG_POOL.ownerPkh,
      sats: BigInt(BIG_POOL.sats),
      tokens: BigInt(BIG_POOL.tokens),
    });
    const executeTxid = chain.addHex(executeRaw, 342_298);
    await sync(params);
    const lagging = new FakeChain();
    for (const stored of chain.txs.values()) lagging.add(stored.transaction, stored.height);
    return { params, orderId: `${fundingTxid}:0`, executeTxid, executeRaw, lagging };
  };

  it('keeps a FILLED order FILLED and its execution confirmed when a lagging server still has the execute in its mempool', async () => {
    // #given a FILLED order and a server one block behind that sees the execute unconfirmed
    const { params, orderId, executeTxid, executeRaw, lagging } = await recordFilled();
    const before = await executionRow(executeTxid);
    lagging.addHex(executeRaw, null);
    lagging.tipHeight = 342_297;
    const laggingObserver = new OrderObserver(lagging, 'chipnet', marketDomain('chipnet'));

    // #when the register path resyncs the address through the lagging server
    await syncOrderAddress(db, laggingObserver, params, {
      sweep: false,
      reason: 'register',
      analytics: testAnalytics,
    });

    // #then nothing moved, and the disagreement is on record
    const row = await order(orderId);
    expect({
      status: row?.status,
      spendHeight: row?.spend_height,
      spendBlockHash: row?.spend_block_hash,
      execution: await executionRow(executeTxid),
      lastEvent: (await events(orderId)).at(-1),
    }).toEqual({
      status: 'FILLED',
      spendHeight: 342_298,
      spendBlockHash: chain.blockHash(342_298),
      execution: before,
      lastEvent: {
        cause: 'server_disagreement',
        decision: 'noop',
        from_status: 'FILLED',
        to_status: 'FILLED',
      },
    });
    expect(before).toMatchObject({ status: 'confirmed', block_height: 342_298 });
  });

  it('keeps a FILLED order FILLED when a server that reached the block shows no spend at all', async () => {
    // #given a FILLED order and a server at the same tip that lost the execute
    const { params, orderId, executeTxid, lagging } = await recordFilled();
    lagging.drop(executeTxid);
    const laggingObserver = new OrderObserver(lagging, 'chipnet', marketDomain('chipnet'));

    // #when it is observed through that server
    await syncOrderAddress(db, laggingObserver, params, {
      sweep: true,
      reason: 'test',
      analytics: testAnalytics,
    });

    // #then only the header-path reorg check could have moved it
    expect({
      status: (await order(orderId))?.status,
      execution: (await executionRow(executeTxid))?.status,
    }).toEqual({ status: 'FILLED', execution: 'confirmed' });
  });

  it('leaves a just-OPEN order OPEN when a failover server one block behind has the funding unconfirmed', async () => {
    // #given an order whose funding confirmed at the tip
    const params = buyParams();
    const funding = fundingTransaction(params, 60_000n);
    const fundingTxid = chain.add(funding, 342_301);
    await sync(params);
    const behind = new FakeChain();
    behind.add(funding, null);
    behind.tipHeight = 342_300;

    // #when the keeper's failover backfill observes it on the lagging server
    await syncOrderAddress(db, new OrderObserver(behind, 'chipnet', marketDomain('chipnet')), params, {
      sweep: true,
      reason: 'failover_backfill',
      analytics: testAnalytics,
    });

    // #then it stays OPEN with its funding block
    const row = await order(`${fundingTxid}:0`);
    expect({
      status: row?.status,
      fundingHeight: row?.funding_height,
      cause: (await events(`${fundingTxid}:0`)).at(-1)?.cause,
    }).toEqual({ status: 'OPEN', fundingHeight: 342_301, cause: 'server_disagreement' });
  });

  it('still moves a FILLED order to RECONCILIATION_REQUIRED when a reorg removes the confirming block', async () => {
    // #given a FILLED order whose execute block left the best chain
    const { orderId, executeTxid } = await recordFilled();
    const confirmedHash = chain.blockHash(342_298);

    // #when the header-path reorg check reports it
    await markReorgedExecutions(db, confirmedHash);
    await recordObservation(db, {
      orderId,
      network: 'chipnet',
      facts: { funding: 'confirmed', spend: { kind: 'none' } },
      funding: undefined,
      spend: undefined,
      forced: { derived: 'RECONCILIATION_REQUIRED', cause: 'reorg', detail: 'test reorg' },
      sweep: false,
    });

    // #then the order and its execution both leave their confirmed states
    expect({
      status: (await order(orderId))?.status,
      execution: (await executionRow(executeTxid))?.status,
    }).toEqual({ status: 'RECONCILIATION_REQUIRED', execution: 'reorged' });
  });
});

describe('order support (shared validator)', () => {
  it('stores a token-carrying buy funding as unsupported funding_mismatch', async () => {
    const params = buyParams();
    const txid = chain.add(fundingTransaction(params, 60_000n, { tokenOnBuy: 5n }), 342_301);
    await sync(params);
    const row = await order(`${txid}:0`);
    expect(row).toMatchObject({ supported: false, unsupported_reason: 'funding_mismatch', status: 'OPEN' });
  });

  it('stores a buy below the market minimum as unsupported amount_below_minimum', async () => {
    const params = buyParams();
    const txid = chain.add(fundingTransaction(params, 10_000n), 342_301);
    await sync(params);
    expect(await order(`${txid}:0`)).toMatchObject({
      supported: false,
      unsupported_reason: 'amount_below_minimum',
    });
  });

  it('tracks a token UTXO sent to a valid buy order address as an unsupported stray, leaving the order supported', async () => {
    const params = buyParams();
    const fundingTxid = chain.add(fundingTransaction(params, 60_000n), 342_301);
    const strayTxid = chain.add(paymentTransaction(orderLockingBytecode(params), 800n, 25n), 342_302);
    await sync(params);
    expect((await order(`${fundingTxid}:0`))?.supported).toBe(true);
    expect(await order(`${strayTxid}:0`)).toMatchObject({
      instance_kind: 'stray',
      parent_order_id: `${fundingTxid}:0`,
      supported: false,
      unsupported_reason: 'funding_mismatch',
    });
    expect(
      await count(db, `SELECT count(*) FROM orders WHERE parent_order_id = $1`, [`${fundingTxid}:0`]),
    ).toBe(1);
  });
});
