import { binToHex } from '@bitauth/libauth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IndexerPool, RostrumPool } from '@atprice/chain';
import { marketDomain, orderAddresses, type OrderParams } from '@atprice/core';
import type { Db } from '../../src/db/pool.js';
import { FACT, readFacts, type HeaderFact, type SubscriptionsFact } from '../../src/facts.js';
import { INTENT_TTL_MS, storeIntent } from '../../src/intent-store.js';
import { Keeper, type KeeperPoolFeed } from '../../src/keeper/keeper.js';
import { syncMarkets } from '../../src/markets.js';
import { paramsToJson, type OrderRow } from '../../src/orders/model.js';
import { OrderObserver } from '../../src/orders/observe.js';
import { syncOrderAddress } from '../../src/orders/sync.js';
import { TEST_DATABASE_URL, count, freshDb, silentLogger, testAnalytics } from '../support/db.js';
import { FakeChain } from '../support/fake-chain.js';
import {
  CAPTURED,
  TOKEN,
  buyParams,
  cancelHex,
  executeHex,
  fundingTransaction,
  seedPool,
} from '../support/orders.js';

// The keeper process end to end on an in-memory Electrum server: boot sequence, NOTIFY handoff and its
// sweep fallback, reconnect and failover backfill, reorg and lag handling, untracking, and the
// order_spent resync after a broadcast conflict.

const BIG_POOL = CAPTURED.pools.reduce((a, b) => (BigInt(a.sats) > BigInt(b.sats) ? a : b));
const UNREACHABLE = 10n ** 15n;

let db: Db;
let chain: FakeChain;
let intentChain: FakeChain;
let observer: OrderObserver;
let keeper: Keeper | undefined;
let nominate: boolean;
let pool: { txid: string; outpoint: string } | undefined;

const disconnectedRostrum = (): KeeperPoolFeed => ({
  connected: false,
  lastUpdateAt: () => undefined,
  poolsOf: (): readonly RostrumPool[] => [],
  onChange: () => () => undefined,
  connect: async () => {
    throw new Error('rostrum unreachable in tests');
  },
  close: async () => undefined,
  subscribe: async () => [],
});

const indexerClient = {
  activePools: async (tokenId: string): Promise<IndexerPool[]> =>
    nominate && pool !== undefined && tokenId === TOKEN
      ? [
          {
            poolId: 'ee'.repeat(32),
            ownerPkh: BIG_POOL.ownerPkh,
            tokenId: TOKEN,
            txid: pool.txid,
            vout: 0,
            sats: BigInt(BIG_POOL.sats),
            tokens: BigInt(BIG_POOL.tokens),
          },
        ]
      : [],
};

const startKeeper = async (): Promise<Keeper> => {
  keeper = new Keeper({
    db,
    databaseUrl: TEST_DATABASE_URL,
    network: 'chipnet',
    chain,
    intentChain,
    rostrum: disconnectedRostrum(),
    indexerClient,
    cauldronBroadcast: null,
    // Long enough that the timer never fires during a test; tests drive sweeps themselves.
    sweepIntervalMs: 600_000,
    keeperId: 'keeper-test',
    logger: silentLogger,
    analytics: testAnalytics,
  });
  await keeper.start();
  return keeper;
};

const running = (): Keeper => {
  if (keeper === undefined) throw new Error('keeper not started');
  return keeper;
};

const waitFor = async (condition: () => Promise<boolean> | boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const status = async (id: string): Promise<string | undefined> =>
  (await db.query<OrderRow>('SELECT status FROM orders WHERE id = $1', [id])).rows[0]?.status;

const fact = async <T>(name: string): Promise<T | undefined> =>
  (await readFacts(db, 'chipnet')).get(name)?.value as T | undefined;

const eventCauses = async (id: string): Promise<string[]> =>
  (
    await db.query<{ cause: string; to_status: string | null }>(
      'SELECT cause, to_status FROM transaction_events WHERE order_id = $1 ORDER BY id',
      [id],
    )
  ).rows.map((row) => `${row.cause}:${row.to_status ?? 'none'}`);

/** Funds an order on the fake chain and records it the way register would, before the keeper boots. */
const recordOrder = async (
  params: OrderParams,
  height: number | null = chain.tipHeight,
): Promise<{ id: string; txid: string; funding: ReturnType<typeof fundingTransaction> }> => {
  const funding = fundingTransaction(params, 100_000n);
  const txid = chain.add(funding, height);
  await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
  return { id: `${txid}:0`, txid, funding };
};

beforeAll(async () => {
  db = await freshDb();
  await syncMarkets(db, 'chipnet');
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE keeper_attempts, executions, transaction_events, orders, order_intents, keeper_facts, evaluator_orders, evaluator_state',
  );
  chain = new FakeChain();
  intentChain = chain.connection('fake.chain');
  observer = new OrderObserver(chain, 'chipnet', marketDomain('chipnet'));
  nominate = true;
  pool = undefined;
  keeper = undefined;
});
afterEach(async () => {
  await keeper?.stop();
});

describe('keeper boot sequence', () => {
  it('reconciles in-flight attempts, backfills the working set and writes every fact health reads', async () => {
    // #given a FUNDING_PENDING order whose funding confirmed while the keeper was down,
    pool = seedPool(chain, BIG_POOL);
    const pending = await recordOrder(buyParams({ minOut: UNREACHABLE }), null);
    expect(await status(pending.id)).toBe('FUNDING_PENDING');
    chain.confirm(pending.txid, chain.tipHeight);
    // #and an OPEN order with a `built` attempt whose transaction never reached the network
    const open = await recordOrder(buyParams({ minOut: UNREACHABLE }));
    await db.query(
      `INSERT INTO keeper_attempts (order_id, network, candidate, quote_age_ms, outcome, txid)
       VALUES ($1, 'chipnet', '{}'::jsonb, 0, 'built', $2)`,
      [open.id, 'ab'.repeat(32)],
    );

    // #when
    const started = await startKeeper();

    // #then
    expect(await status(pending.id)).toBe('OPEN');
    expect(
      (
        await db.query<{ outcome: string }>('SELECT outcome FROM keeper_attempts WHERE order_id = $1', [
          open.id,
        ])
      ).rows[0]?.outcome,
    ).toBe('dropped');
    expect(started.indexer.trackedCount).toBe(2);
    expect(started.indexer.unsubscribedCount).toBe(0);
    const facts = await readFacts(db, 'chipnet');
    expect(facts.get(FACT.header)?.value).toMatchObject({ height: chain.tipHeight, server: 'fake.chain' });
    expect(facts.get(FACT.subscriptions)?.value).toMatchObject({ ok: true, expected: 2, subscribed: 2 });
    expect(facts.has(FACT.sweep)).toBe(true);
    expect(facts.has(`pool:${TOKEN}`)).toBe(true);
    expect(facts.get(`pool_source:${TOKEN}`)?.value).toMatchObject({ source: 'indexer_rest' });
    expect(facts.get(FACT.keeperBoot)?.value).toMatchObject({ keeperId: 'keeper-test' });
  });

  it('reports subscriptions_ok false while order subscriptions fail, and true once a reconnect restores them', async () => {
    // #given an OPEN order and a server refusing subscriptions
    await recordOrder(buyParams({ minOut: UNREACHABLE }));
    chain.failSubscriptions = true;

    // #when
    await startKeeper();

    // #then
    expect(running().indexer.unsubscribedCount).toBe(1);
    expect(await fact<SubscriptionsFact>(FACT.subscriptions)).toMatchObject({ ok: false, subscribed: 0 });

    // #when the server recovers and the connection comes back
    chain.failSubscriptions = false;
    await chain.reconnect({ failover: false });

    // #then
    expect(running().indexer.unsubscribedCount).toBe(0);
    expect(await fact<SubscriptionsFact>(FACT.subscriptions)).toMatchObject({ ok: true, subscribed: 1 });
  });
});

describe('keeper execution', () => {
  it('fills two executable orders on one pool in one sweep and sees both spends through its subscriptions', async () => {
    // #given two executable orders recorded OPEN before boot, and no pool nominated yet
    pool = seedPool(chain, BIG_POOL);
    nominate = false;
    const first = await recordOrder(buyParams());
    const second = await recordOrder(buyParams());
    await startKeeper();
    expect(chain.broadcasts).toHaveLength(0);

    // #when the pool is nominated and one sweep runs
    nominate = true;
    await running().sweep();

    // #then both fills went out, the second chained on the first fill's pool output
    expect(chain.broadcasts).toHaveLength(2);
    await waitFor(
      async () =>
        (await status(first.id)) === 'EXECUTION_PENDING' && (await status(second.id)) === 'EXECUTION_PENDING',
      'both orders to reach EXECUTION_PENDING from status notifications',
    );
  });

  it('resyncs the order at once when a broadcast conflicts with a spend of the order outpoint', async () => {
    // #given an executable OPEN order and a cancel that lands just before the keeper's broadcast
    pool = seedPool(chain, BIG_POOL);
    nominate = false;
    const params = buyParams();
    const order = await recordOrder(params);
    await startKeeper();
    const cancel = cancelHex(params, order.txid, order.funding);
    chain.beforeBroadcast = () => {
      chain.beforeBroadcast = undefined;
      chain.addHex(cancel, null);
    };

    // #when the executor runs (a pool event, not a sweep, so no backfill runs first)
    nominate = true;
    const summary = await running().executor.trigger(TOKEN, 'pool_event');

    // #then
    expect(summary?.attempts.map((attempt) => attempt.outcome)).toEqual(['order_spent']);
    expect(await status(order.id)).toBe('CANCELLATION_PENDING');
  });
});

describe('keeper reconnect and failover', () => {
  it('backfills every tracked order after a failover and records the new server in its facts', async () => {
    // #given an OPEN order, then a cancel the keeper misses while its connection is down
    const params = buyParams({ minOut: UNREACHABLE });
    const order = await recordOrder(params);
    await startKeeper();
    chain.connected = false;
    chain.addHex(cancelHex(params, order.txid, order.funding), null);
    expect(await status(order.id)).toBe('OPEN');

    // #when the client fails over to another server
    await chain.reconnect({ failover: true, host: 'fake.failover' });

    // #then
    await waitFor(async () => (await status(order.id)) === 'CANCELLATION_PENDING', 'failover backfill');
    await waitFor(
      async () => (await fact<HeaderFact>(FACT.header))?.server === 'fake.failover',
      'the header fact from the new server',
    );
    expect(await fact<SubscriptionsFact>(FACT.subscriptions)).toMatchObject({ ok: true });
  });
});

describe('keeper headers, reorgs and lag', () => {
  const filledOrder = async (): Promise<{ id: string; executeTxid: string; height: number }> => {
    pool = seedPool(chain, BIG_POOL, chain.tipHeight - 5);
    nominate = false;
    const params = buyParams();
    const order = await recordOrder(params, chain.tipHeight - 3);
    const height = chain.tipHeight - 2;
    const executeTxid = chain.addHex(
      executeHex(params, order.txid, order.funding, {
        txid: pool.txid,
        vout: 0,
        ownerPkh: BIG_POOL.ownerPkh,
        sats: BigInt(BIG_POOL.sats),
        tokens: BigInt(BIG_POOL.tokens),
      }),
      height,
    );
    await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
    expect(await status(order.id)).toBe('FILLED');
    return { id: order.id, executeTxid, height };
  };

  it('moves a FILLED order through RECONCILIATION_REQUIRED and back when its block is reorged out', async () => {
    // #given
    const filled = await filledOrder();
    await startKeeper();

    // #when the block holding the execute is replaced and a new header arrives
    chain.reorgBlock(filled.height);
    await chain.emitHeader(chain.tipHeight + 1);

    // #then
    await waitFor(
      async () => (await eventCauses(filled.id)).includes('reorg:RECONCILIATION_REQUIRED'),
      'the reorg event',
    );
    await waitFor(async () => (await status(filled.id)) === 'FILLED', 'the resync back to FILLED');
    const { rows } = await db.query<{ spend_block_hash: string }>(
      'SELECT spend_block_hash FROM orders WHERE id = $1',
      [filled.id],
    );
    expect(rows[0]?.spend_block_hash).toBe('cc'.repeat(32));
  });

  it('treats a header from a lagging server as lag, not a reorg, and never lowers the recorded tip', async () => {
    // #given a FILLED order confirmed two blocks below the tip
    const filled = await filledOrder();
    await startKeeper();
    const tip = chain.tipHeight;

    // #when a failover lands on a server three blocks behind
    chain.endpoint = { ...chain.endpoint, host: 'fake.lagging' };
    chain.announceHeader({ height: tip - 3, hash: 'dd'.repeat(32), hex: '00'.repeat(80) });
    await running().indexer.onHeader(
      { height: tip, hash: chain.blockHash(tip), hex: '00'.repeat(80) },
      'barrier',
    );

    // #then
    expect(await status(filled.id)).toBe('FILLED');
    expect(await eventCauses(filled.id)).not.toContain('reorg:RECONCILIATION_REQUIRED');
    expect(
      (
        await db.query<{ status: string }>('SELECT status FROM executions WHERE txid = $1', [
          filled.executeTxid,
        ])
      ).rows[0]?.status,
    ).toBe('confirmed');
    expect((await fact<HeaderFact>(FACT.header))?.height).toBe(tip);
  });

  it('handles headers one at a time, so one delivered late cannot overwrite a newer one', async () => {
    // #given
    await startKeeper();
    const tip = chain.tipHeight;

    // #when two headers arrive back to back, the newer first
    chain.announceHeader({ height: tip + 2, hash: chain.blockHash(tip + 2), hex: '00'.repeat(80) });
    chain.announceHeader({ height: tip + 1, hash: chain.blockHash(tip + 1), hex: '00'.repeat(80) });
    const outcome = await running().indexer.onHeader(
      { height: tip + 1, hash: chain.blockHash(tip + 1), hex: '00'.repeat(80) },
      'barrier',
    );

    // #then
    expect(outcome.recorded).toBe(false);
    expect(await fact<HeaderFact>(FACT.header)).toMatchObject({ height: tip + 2, server: 'fake.chain' });
  });
});

describe('keeper intents', () => {
  const intentFor = async (params: OrderParams): Promise<string> => {
    const addresses = orderAddresses(params, 'chipnet');
    const stored = await storeIntent(db, {
      network: 'chipnet',
      orderAddress: addresses.address,
      orderLockingBytecode: binToHex(addresses.lockingBytecode),
      side: params.side,
      tokenId: params.tokenCategory,
      amount: '100000',
      params: paramsToJson(params),
      clientPrefix: '203.0.113.7',
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    });
    if (stored.kind !== 'stored') throw new Error(stored.kind);
    return stored.intent.id;
  };

  it('picks an intent up from NOTIFY and hands the funded order to the indexer', async () => {
    // #given
    await startKeeper();
    const params = buyParams({ minOut: UNREACHABLE });

    // #when the API stores an intent (its insert trigger sends NOTIFY order_intent)
    const intentId = await intentFor(params);

    // #then
    await waitFor(() => running().intents.watchedCount === 1, 'the NOTIFY handoff');
    expect(intentChain.subscribedCount()).toBe(1);

    // #when the funding reaches the mempool
    const fundingTxid = chain.publish(fundingTransaction(params, 100_000n), null);

    // #then
    await waitFor(async () => (await status(`${fundingTxid}:0`)) === 'FUNDING_PENDING', 'the funded order');
    await waitFor(() => running().intents.watchedCount === 0, 'the intent to be released');
    const { rows } = await db.query<{ status: string; funded_order_id: string }>(
      'SELECT status, funded_order_id FROM order_intents WHERE id = $1',
      [intentId],
    );
    expect(rows[0]).toEqual({ status: 'funded', funded_order_id: `${fundingTxid}:0` });
    expect(running().indexer.trackedCount).toBe(1);
    expect(intentChain.subscribedCount()).toBe(0);
  });

  it('loads an intent whose NOTIFY was missed on the next sweep', async () => {
    // #given an intent inserted while nothing was listening
    await startKeeper();
    await db.query('ALTER TABLE order_intents DISABLE TRIGGER order_intents_notify');
    try {
      await intentFor(buyParams({ minOut: UNREACHABLE }));
    } finally {
      await db.query('ALTER TABLE order_intents ENABLE TRIGGER order_intents_notify');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(running().intents.watchedCount).toBe(0);

    // #when
    await running().sweep();

    // #then
    expect(running().intents.watchedCount).toBe(1);
    expect(await fact<SubscriptionsFact>(FACT.subscriptions)).toMatchObject({ ok: true, expected: 1 });
  });
});

describe('intent retention (architecture.md, API: IPs truncated, kept 7 days)', () => {
  const insertIntent = async (
    clientPrefix: string,
    status: 'live' | 'expired' | 'funded',
    createdAgo: string,
    lockingSuffix: string,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO order_intents (network, order_address, order_locking_bytecode, side, token_id, amount, params, client_prefix, status, created_at, expires_at)
       VALUES ('chipnet', 'bchtest:retention', $1, 'buy', $2, 100000, $6, $3, $4, now() - $5::interval, now() + interval '1 day')`,
      [
        `aa${lockingSuffix}`,
        TOKEN,
        clientPrefix,
        status,
        createdAgo,
        JSON.stringify(paramsToJson(buyParams({ minOut: UNREACHABLE }))),
      ],
    );
  };

  it('cuts full client IPv4 addresses to /24 after an hour and deletes settled intents after 7 days', async () => {
    // #given intents of every age and status
    await insertIntent('203.0.113.7', 'live', '10 minutes', '01');
    await insertIntent('203.0.113.8', 'live', '2 hours', '02');
    await insertIntent('2001:db8:1:2::/64', 'live', '2 hours', '03');
    await insertIntent('198.51.100.9', 'expired', '8 days', '04');
    await insertIntent('198.51.100.10', 'funded', '8 days', '05');
    await insertIntent('198.51.100.11', 'funded', '6 days', '06');
    await startKeeper();

    // #when the keeper sweeps (boot already ran one; run another to show it is idempotent)
    await running().sweep();

    // #then
    const { rows } = await db.query<{ order_locking_bytecode: string; client_prefix: string }>(
      'SELECT order_locking_bytecode, client_prefix FROM order_intents ORDER BY order_locking_bytecode',
    );
    expect(rows).toEqual([
      { order_locking_bytecode: 'aa01', client_prefix: '203.0.113.7' },
      { order_locking_bytecode: 'aa02', client_prefix: '203.0.113.0/24' },
      { order_locking_bytecode: 'aa03', client_prefix: '2001:db8:1:2::/64' },
      { order_locking_bytecode: 'aa06', client_prefix: '198.51.100.0/24' },
    ]);
  });
});

describe('keeper untracking', () => {
  it('stops watching an order address once its order is terminal', async () => {
    // #given a tracked OPEN order
    const params = buyParams({ minOut: UNREACHABLE });
    const order = await recordOrder(params);
    await startKeeper();
    expect(running().indexer.trackedCount).toBe(1);
    const subscribed = chain.subscribedCount();

    // #when its cancel confirms
    chain.publishHex(cancelHex(params, order.txid, order.funding), chain.tipHeight);

    // #then
    await waitFor(async () => (await status(order.id)) === 'CANCELLED', 'the cancel to settle');
    await waitFor(() => running().indexer.trackedCount === 0, 'the address to be untracked');
    expect(chain.subscribedCount()).toBe(subscribed - 1);
    expect(await count(db, `SELECT count(*) FROM orders WHERE status NOT IN ('FILLED', 'CANCELLED')`)).toBe(
      0,
    );
  });
});
