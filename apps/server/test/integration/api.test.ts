import { binToHex, encodeLockingBytecodeP2pkh, hexToBin } from '@bitauth/libauth';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAIN_NETWORKS, CauldronIndexerClient } from '@atprice/chain';
import {
  cancelPrepareSchema,
  evidenceSchema,
  executionSchema,
  healthSchema,
  intentSchema,
  marketDetailSchema,
  marketsSchema,
  networkStatusSchema,
  orderExecutionsSchema,
  orderListSchema,
  orderSchema,
  quoteSchema,
  registrationSchema,
} from '@atprice/api-schema';
import {
  buildCancelTransaction,
  instantiateOrder,
  marketDomain,
  orderAddresses,
  type OrderParams,
} from '@atprice/core';
import { QuoteService, QUOTE_TTL_MS } from '../../src/api/quotes.js';
import {
  INTENTS_PER_CLIENT_PER_HOUR,
  LIVE_INTENTS_GLOBAL,
  buildServer,
  type ApiContext,
} from '../../src/api/server.js';
import type { Db } from '../../src/db/pool.js';
import { FACT, writeFact } from '../../src/facts.js';
import { syncMarkets } from '../../src/markets.js';
import { ownerAddress } from '../../src/orders/model.js';
import { OrderObserver } from '../../src/orders/observe.js';
import { syncOrderAddress } from '../../src/orders/sync.js';
import { CORE_MATHS, bestPoolQuote, keeperExecuteFee } from '../../src/pools/quote.js';
import { readLivePools } from '../../src/pools/reader.js';
import { count, freshDb, silentLogger, testAnalytics } from '../support/db.js';
import { FakeChain } from '../support/fake-chain.js';
import {
  CAPTURED,
  OWNER,
  TOKEN,
  buyParams,
  cancelHex,
  executeHex,
  fundingTransaction,
  orderUtxoOf,
  provider,
  seedPool,
  sellParams,
} from '../support/orders.js';

const WEB_ORIGIN = 'https://atprice.example';
const BIG_POOL = CAPTURED.pools.reduce((a, b) => (BigInt(a.sats) > BigInt(b.sats) ? a : b));

let db: Db;
let chain: FakeChain;
let observer: OrderObserver;
let app: FastifyInstance;
let pool: { txid: string; outpoint: string };

beforeAll(async () => {
  db = await freshDb();
  await syncMarkets(db, 'chipnet');
});
afterAll(async () => {
  await db.end();
});

const indexerFetch = (): typeof fetch => async () =>
  new Response(
    JSON.stringify({
      active: [
        {
          owner_p2pkh_addr: 'bchtest:z',
          owner_pkh: BIG_POOL.ownerPkh,
          pool_id: 'ee'.repeat(32),
          sats: Number(BIG_POOL.sats),
          token_id: TOKEN,
          tokens: Number(BIG_POOL.tokens),
          tx_pos: 0,
          txid: pool.txid,
        },
      ],
    }),
    { status: 200 },
  );

const start = async (overrides: Partial<ApiContext> = {}): Promise<FastifyInstance> => {
  const server = await buildServer({
    db,
    network: 'chipnet',
    webOrigin: WEB_ORIGIN,
    trustProxy: false,
    sweepIntervalMs: 30_000,
    evalIntervalMs: 30_000,
    chain,
    observer,
    provider,
    quotes: new QuoteService(new CauldronIndexerClient({ network: 'chipnet', fetch: indexerFetch() }), chain),
    logger: silentLogger,
    analytics: testAnalytics,
    limits: { perMinute: 1_000, writesPerMinute: 1_000 },
    ...overrides,
  });
  await server.ready();
  return server;
};

beforeEach(async () => {
  await db.query(
    'TRUNCATE keeper_attempts, executions, transaction_events, orders, order_intents, keeper_facts, evaluator_orders, evaluator_state',
  );
  chain = new FakeChain();
  observer = new OrderObserver(chain, 'chipnet', marketDomain('chipnet'));
  pool = seedPool(chain, BIG_POOL);
  app = await start();
});
afterEach(async () => {
  await app.close();
});

const intentBody = (params: OrderParams, amount: bigint, orderAddress?: string) => ({
  side: params.side,
  ownerPkh: binToHex(params.ownerPkh),
  recipientLockingBytecode: binToHex(params.recipientLockingBytecode),
  tokenCategory: params.tokenCategory,
  minOut: params.minOut.toString(),
  maxNetworkFee: params.maxNetworkFee.toString(),
  nonce: binToHex(params.nonce),
  amount: amount.toString(),
  orderAddress:
    orderAddress ??
    (params.side === 'sell'
      ? orderAddresses(params, 'chipnet').tokenAddress
      : orderAddresses(params, 'chipnet').address),
});

const fund = (params: OrderParams, amount: bigint, height: number | null = chain.tipHeight) => {
  const funding = fundingTransaction(params, amount);
  const txid = chain.add(funding, height);
  return { funding, txid, id: `${txid}:0` };
};

describe('markets and quotes', () => {
  it('lists the core allowlist for the network', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/markets' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      network: 'chipnet',
      markets: [{ tokenId: TOKEN, symbol: 'PUSDTEST', decimals: 2 }],
    });
  });

  it('answers 404 for a token that is not a supported market and 400 for a malformed one', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/markets/${'ab'.repeat(32)}` })).json(),
    ).toMatchObject({
      error: 'market_unsupported',
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/markets/PUSD' })).statusCode).toBe(400);
  });

  it('quotes a buy with core maths on the live pool read, with a 15 s expiry and the pool used', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/markets/${TOKEN}/quote?side=buy&amount=100000`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      receive: string;
      pool: { outpoint: { txid: string; vout: number } };
      calculatedAt: string;
      expiresAt: string;
    }>();
    const pools = (
      await readLivePools(chain, TOKEN, [{ ownerPkh: BIG_POOL.ownerPkh, outpoint: pool.outpoint }])
    ).pools;
    const expected = bestPoolQuote(
      CORE_MATHS,
      { side: 'buy', satoshis: 100_000n + 1000n + 2000n, tokenAmount: 0n },
      pools,
      keeperExecuteFee(2000n),
    );
    expect(body.receive).toBe(expected?.recipientAmount.toString());
    expect(`${body.pool.outpoint.txid}:${body.pool.outpoint.vout}`).toBe(pool.outpoint);
    expect(Date.parse(body.expiresAt) - Date.parse(body.calculatedAt)).toBe(QUOTE_TTL_MS);
  });

  it('rejects a quote without a side or with unknown query fields', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/markets/${TOKEN}/quote?amount=1` })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/markets/${TOKEN}/quote?side=buy&amount=1&x=1` }))
        .statusCode,
    ).toBe(400);
  });
});

describe('order intents', () => {
  it('stores an intent whose address the server derives identically', async () => {
    const params = buyParams();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: intentBody(params, 100_000n),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: 'live',
      orderAddress: orderAddresses(params, 'chipnet').address,
    });
    expect(await count(db, `SELECT count(*) FROM order_intents WHERE status = 'live'`)).toBe(1);
    const { intentId } = response.json<{ intentId: string }>();
    expect(testAnalytics.events).toContainEqual({
      event: 'order_created',
      fields: { intentId, side: 'buy', tokenId: TOKEN, amount: '100000' },
    });
  });

  it('names an address mismatch and blocks funding', async () => {
    const params = buyParams();
    const other = orderAddresses(buyParams(), 'chipnet').address;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: intentBody(params, 100_000n, other),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'address_mismatch',
      serverOrderAddress: orderAddresses(params, 'chipnet').address,
    });
  });

  it('rejects out-of-domain parameters with the core reason', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: intentBody(buyParams({ maxNetworkFee: 999n }), 100_000n),
    });
    expect(response.json()).toMatchObject({ error: 'max_network_fee_range' });
    const small = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: intentBody(buyParams(), 49_999n),
    });
    expect(small.json()).toMatchObject({ error: 'amount_below_minimum' });
  });

  it('rejects unknown body fields and bodies over 16 KB', async () => {
    const extra = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: { ...intentBody(buyParams(), 100_000n), xpub: 'tpub' },
    });
    expect(extra.statusCode).toBe(400);
    const large = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: JSON.stringify({ padding: 'x'.repeat(17 * 1024) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(large.statusCode).toBe(413);
    expect(large.json()).toMatchObject({ error: 'body_too_large' });
  });

  it(`caps intents at ${INTENTS_PER_CLIENT_PER_HOUR} per client per hour with a named 429`, async () => {
    for (let i = 0; i < INTENTS_PER_CLIENT_PER_HOUR; i += 1) {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/intents',
        payload: intentBody(buyParams(), 100_000n),
      });
      expect(ok.statusCode).toBe(201);
    }
    const capped = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: intentBody(buyParams(), 100_000n),
    });
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ error: 'intent_rate_limited' });
  });

  it('holds the per-client cap under concurrent requests', async () => {
    await app.close();
    app = await start({ limits: { perMinute: 1_000, writesPerMinute: 30 } });
    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/orders/intents',
          payload: intentBody(buyParams(), 100_000n),
        }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((code) => code === 201)).toHaveLength(INTENTS_PER_CLIENT_PER_HOUR);
    expect(statuses.filter((code) => code === 429)).toHaveLength(30 - INTENTS_PER_CLIENT_PER_HOUR);
    expect(
      responses.filter((response) => response.statusCode === 429).map((response) => response.json().error),
    ).toEqual(Array.from({ length: 30 - INTENTS_PER_CLIENT_PER_HOUR }, () => 'intent_rate_limited'));
    expect(await count(db, 'SELECT count(*) FROM order_intents')).toBe(INTENTS_PER_CLIENT_PER_HOUR);
  });

  const seedIntents = async (
    rows: number,
    status: 'live' | 'expired',
    expiresIn: string,
    lockingPrefix: string,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO order_intents (network, order_address, order_locking_bytecode, side, token_id, amount, params, client_prefix, status, expires_at)
       SELECT 'chipnet', 'bchtest:seed' || i, $1 || lpad(to_hex(i), 8, '0'), 'buy', $2, 100000, '{}'::jsonb,
              '10.' || (i / 65536) || '.' || ((i / 256) % 256) || '.' || (i % 256), $3, now() + $4::interval
         FROM generate_series(1, $5::int) AS i`,
      [lockingPrefix, TOKEN, status, expiresIn, rows],
    );
  };

  it(`answers intent_capacity once ${LIVE_INTENTS_GLOBAL} unexpired live intents exist`, async () => {
    await seedIntents(LIVE_INTENTS_GLOBAL, 'live', '1 hour', 'aa');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: intentBody(buyParams(), 100_000n),
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: 'intent_capacity' });
  });

  it('does not count expired or funded intents against the global cap', async () => {
    await seedIntents(LIVE_INTENTS_GLOBAL / 2, 'expired', '-1 hour', 'bb');
    await db.query(
      `INSERT INTO order_intents (network, order_address, order_locking_bytecode, side, token_id, amount, params, client_prefix, status, expires_at)
       SELECT 'chipnet', 'bchtest:funded' || i, 'ff' || lpad(to_hex(i), 8, '0'), 'buy', $1, 100000, '{}'::jsonb,
              '10.200.' || (i / 256) || '.' || (i % 256), 'funded', now() + interval '1 hour'
         FROM generate_series(1, $2::int) AS i`,
      [TOKEN, LIVE_INTENTS_GLOBAL / 2],
    );
    // Live by status but past expiry and not yet swept: also not a live watch.
    await db.query(
      `INSERT INTO order_intents (network, order_address, order_locking_bytecode, side, token_id, amount, params, client_prefix, status, expires_at)
       VALUES ('chipnet', 'bchtest:stale', 'ee00000001', 'buy', $1, 100000, '{}'::jsonb, '10.250.0.1', 'live', now() - interval '1 minute')`,
      [TOKEN],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: intentBody(buyParams(), 100_000n),
    });
    expect(response.statusCode).toBe(201);
  });

  it('keys the intent cap by the forwarded client only when the proxy is trusted', async () => {
    await app.close();
    app = await start({ trustProxy: ['127.0.0.1'] });
    for (let i = 0; i < INTENTS_PER_CLIENT_PER_HOUR; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/orders/intents',
        payload: intentBody(buyParams(), 100_000n),
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
    }
    const otherClient = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: intentBody(buyParams(), 100_000n),
      headers: { 'x-forwarded-for': '198.51.100.9' },
    });
    expect(otherClient.statusCode).toBe(201);

    await app.close();
    app = await start({ trustProxy: false });
    const spoofed = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/intents',
      payload: intentBody(buyParams(), 100_000n),
      headers: { 'x-forwarded-for': '192.0.2.44' },
    });
    expect(spoofed.statusCode).toBe(201);
    const { rows } = await db.query<{ client_prefix: string }>(
      'SELECT DISTINCT client_prefix FROM order_intents ORDER BY client_prefix',
    );
    expect(rows.map((row) => row.client_prefix)).toEqual(['127.0.0.1', '198.51.100.9', '203.0.113.7']);
  });
});

describe('register and order reads', () => {
  it('registers a funding transaction idempotently, keyed by the funding outpoint', async () => {
    const params = buyParams();
    const { txid, id } = fund(params, 100_000n, null);
    const first = await app.inject({ method: 'POST', url: '/api/v1/orders/register', payload: { txid } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      order: { id, status: 'FUNDING_PENDING', supported: true, inputAmount: '100000' },
    });
    const again = await app.inject({ method: 'POST', url: '/api/v1/orders/register', payload: { txid } });
    expect(again.json()).toMatchObject({ order: { id } });
    expect(await count(db, 'SELECT count(*) FROM orders')).toBe(1);
  });

  it('answers 404 for an unknown txid and 422 for a transaction that is not an order', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/register',
      payload: { txid: 'cd'.repeat(32) },
    });
    expect(missing.json()).toMatchObject({ error: 'transaction_not_found' });
    const notOrder = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/register',
      payload: { txid: pool.txid },
    });
    expect(notOrder.statusCode).toBe(422);
    expect(notOrder.json()).toMatchObject({ error: 'record_missing' });
  });

  it('reads an order with its events, and lists orders only by exact owner address or outpoints', async () => {
    const params = buyParams();
    const { id } = fund(params, 100_000n);
    await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
    const order = await app.inject({ method: 'GET', url: `/api/v1/orders/${id}` });
    expect(order.json()).toMatchObject({
      id,
      status: 'OPEN',
      order: { id, status: 'OPEN' },
      instances: [],
      events: [{ txid: id.split(':')[0], kind: 'funding', networkState: 'confirmed' }],
      log: [{ cause: 'backfill', to: 'OPEN' }],
    });

    const owner = ownerAddress(OWNER.pkh, 'chipnet');
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/orders?address=${owner}` })).json(),
    ).toMatchObject({ orders: [{ id }] });
    expect((await app.inject({ method: 'GET', url: `/api/v1/orders?outpoints=${id}` })).json()).toMatchObject(
      { orders: [{ id }] },
    );
    const fuzzy = await app.inject({ method: 'GET', url: `/api/v1/orders?address=${owner.slice(0, 20)}` });
    expect(fuzzy.json()).toMatchObject({ error: 'owner_address_invalid' });
    const both = await app.inject({ method: 'GET', url: `/api/v1/orders?address=${owner}&outpoints=${id}` });
    expect(both.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/v1/orders/${'ef'.repeat(32)}:0` })).statusCode).toBe(
      404,
    );
  });

  it('prepares an unsigned cancel that the browser can rebuild byte for byte', async () => {
    const params = sellParams();
    const { funding, txid, id } = fund(params, 500n);
    await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${id}/cancel/prepare`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const change = funding.outputs[2];
    if (change === undefined) throw new Error('no owner change');
    const local = buildCancelTransaction({
      owner: {
        utxos: [
          {
            txid,
            vout: 2,
            satoshis: change.valueSatoshis,
            lockingBytecode: binToHex(encodeLockingBytecodeP2pkh(OWNER.pkh)),
          },
        ],
      },
      orders: [{ order: instantiateOrder(params, provider), utxo: orderUtxoOf(txid, funding) }],
    });
    expect(response.json()).toMatchObject({
      orderId: id,
      unsignedHex: local.unsignedHex,
      ownerUtxo: { txid, vout: 2 },
    });
  });

  it('names an empty owner address when preparing a cancel, with the amount to send', async () => {
    const params = buyParams();
    const { funding, txid, id } = fund(params, 100_000n);
    await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
    chain.add(
      {
        version: 2,
        locktime: 0,
        inputs: [
          {
            outpointTransactionHash: hexToBin(txid),
            outpointIndex: 2,
            sequenceNumber: 0,
            unlockingBytecode: new Uint8Array(),
          },
        ],
        outputs: [
          {
            lockingBytecode: encodeLockingBytecodeP2pkh(new Uint8Array(20).fill(7)),
            valueSatoshis: funding.outputs[2]?.valueSatoshis ?? 0n,
          },
        ],
      },
      null,
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${id}/cancel/prepare`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'owner_address_empty',
      ownerAddress: ownerAddress(OWNER.pkh, 'chipnet'),
    });
  });

  it('serves executions, attempts and evidence from observed transactions only', async () => {
    const params = buyParams();
    const { funding, txid, id } = fund(params, 100_000n);
    const executeTxid = chain.addHex(
      executeHex(params, txid, funding, {
        txid: pool.txid,
        vout: 0,
        ownerPkh: BIG_POOL.ownerPkh,
        sats: BigInt(BIG_POOL.sats),
        tokens: BigInt(BIG_POOL.tokens),
      }),
      chain.tipHeight,
    );
    await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
    const execution = await app.inject({ method: 'GET', url: `/api/v1/executions/${executeTxid}` });
    expect(execution.json()).toMatchObject({
      execution: { orderId: id, txid: executeTxid, status: 'confirmed', byAtPriceKeeper: false },
    });
    const perOrder = await app.inject({ method: 'GET', url: `/api/v1/orders/${id}/executions` });
    expect(perOrder.json()).toMatchObject({ executions: [{ txid: executeTxid }], attempts: [] });
    const evidence = await app.inject({ method: 'GET', url: '/api/v1/evidence' });
    expect(evidence.json()).toMatchObject({
      network: 'chipnet',
      fills: [
        {
          txid: executeTxid,
          explorerUrl: `https://chipnet.imaginary.cash/tx/${executeTxid}`,
          funding: { txid },
        },
      ],
      cancels: [],
    });
  });
});

describe('health, network and hardening', () => {
  it('answers 503 with named reasons when the keeper has reported nothing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      network: 'chipnet',
      reasons: [
        'tip_lag',
        'sweep_stale',
        'pool_data_stale',
        'subscriptions_incomplete',
        'evaluator_unavailable',
      ],
    });
  });

  it('reports the network and genesis hash the web app compares against its build', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/network' });
    expect(response.json()).toMatchObject({
      network: 'chipnet',
      genesisHash: CHAIN_NETWORKS.chipnet.genesisHash,
      api: { electrumConnected: true, electrumServer: 'fake.chain' },
      metrics: { openOrders: 0, executableBacklog: 0 },
    });
  });

  it('sends CORS only for the web origin and helmet headers on every response', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/markets',
      headers: { origin: WEB_ORIGIN },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['content-security-policy']).toContain("default-src 'none'");
    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/markets',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('rate limits per client with a named 429', async () => {
    await app.close();
    app = await start({ limits: { perMinute: 3, writesPerMinute: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1)
      statuses.push((await app.inject({ method: 'GET', url: '/api/v1/markets' })).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await app.inject({ method: 'GET', url: '/api/v1/markets' });
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
  });
});

describe('the web client contract (@atprice/api-schema)', () => {
  const expectContract = (
    schema: { safeParse: (value: unknown) => { success: boolean; error?: unknown } },
    body: unknown,
  ) => {
    const result = schema.safeParse(body);
    expect(result.error).toBeUndefined();
  };

  it('answers every endpoint the web calls with a body its schema parses', async () => {
    // #given an open order, a filled order, a cancelled order and a recorded keeper tip
    await writeFact(db, 'chipnet', FACT.header, {
      height: chain.tipHeight,
      hash: chain.blockHash(chain.tipHeight),
      server: 'fake.chain',
    });
    const open = buyParams();
    const opened = fund(open, 100_000n);
    const filled = buyParams();
    const filledFunding = fund(filled, 100_000n);
    const executeTxid = chain.addHex(
      executeHex(filled, filledFunding.txid, filledFunding.funding, {
        txid: pool.txid,
        vout: 0,
        ownerPkh: BIG_POOL.ownerPkh,
        sats: BigInt(BIG_POOL.sats),
        tokens: BigInt(BIG_POOL.tokens),
      }),
      chain.tipHeight,
    );
    const cancelled = sellParams();
    const cancelledFunding = fund(cancelled, 500n);
    chain.addHex(cancelHex(cancelled, cancelledFunding.txid, cancelledFunding.funding), chain.tipHeight);
    for (const params of [open, filled, cancelled]) {
      await syncOrderAddress(db, observer, params, {
        sweep: false,
        reason: 'test',
        analytics: testAnalytics,
      });
    }
    const get = async (url: string) => (await app.inject({ method: 'GET', url: `/api/v1${url}` })).json();
    const post = async (url: string, payload: object) =>
      (await app.inject({ method: 'POST', url: `/api/v1${url}`, payload })).json();
    const owner = ownerAddress(OWNER.pkh, 'chipnet');

    // #when / #then each response parses with the schema the web client uses for it
    expectContract(networkStatusSchema, await get('/network'));
    expectContract(healthSchema, await get('/health'));
    expectContract(marketsSchema, await get('/markets'));
    expectContract(marketDetailSchema, await get(`/markets/${TOKEN}`));
    expectContract(quoteSchema, await get(`/markets/${TOKEN}/quote?side=buy&amount=100000`));
    expectContract(quoteSchema, await get(`/markets/${TOKEN}/quote?side=sell&amount=500`));
    expectContract(intentSchema, await post('/orders/intents', intentBody(buyParams(), 100_000n)));
    expectContract(registrationSchema, await post('/orders/register', { txid: opened.txid }));
    expectContract(registrationSchema, await post('/orders/register', { txid: filledFunding.txid }));
    for (const id of [opened.id, filledFunding.id, cancelledFunding.id]) {
      expectContract(orderSchema, await get(`/orders/${id}`));
      expectContract(orderExecutionsSchema, await get(`/orders/${id}/executions`));
    }
    expectContract(orderListSchema, await get(`/orders?address=${owner}`));
    expectContract(orderListSchema, await get(`/orders?outpoints=${opened.id},${filledFunding.id}`));
    expectContract(executionSchema, await get(`/executions/${executeTxid}`));
    const evidence = evidenceSchema.parse(await get('/evidence'));
    expect(evidence.orders.map((order) => order.settlement.kind).sort()).toEqual(['cancel', 'fill']);
    const firstPage = evidenceSchema.parse(await get('/evidence?limit=1'));
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = evidenceSchema.parse(await get(`/evidence?limit=1&cursor=${firstPage.nextCursor}`));
    expect(secondPage.orders[0]?.id).not.toBe(firstPage.orders[0]?.id);
    const sellOrder = await get(`/orders/${cancelledFunding.id}`);
    expect(sellOrder.settlement).toMatchObject({ kind: 'cancel', refundSats: '2000', refundTokens: '500' });
  });

  it('answers cancel prepare with a body the web schema parses', async () => {
    const params = sellParams();
    const { id } = fund(params, 500n);
    await syncOrderAddress(db, observer, params, { sweep: false, reason: 'test', analytics: testAnalytics });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${id}/cancel/prepare`,
      payload: {},
    });
    expectContract(cancelPrepareSchema, response.json());
  });
});
