import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import {
  binToHex,
  decodePrivateKeyWif,
  decodeTransactionBch,
  hash160,
  hexToBin,
  secp256k1,
} from '@bitauth/libauth';
import { SignatureTemplate, TransactionBuilder, type Utxo } from 'cashscript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CauldronIndexerClient,
  type ChainClient,
  type IndexerPool,
  type RostrumPoolClient,
} from '@atprice/chain';
import { createNodeChainClient, createNodeRostrumClient } from '@atprice/chain/node';
import {
  DEFAULT_MAX_NETWORK_FEE,
  SUPPORTED_MARKETS,
  buildExecuteTransaction,
  buildFundingTransaction,
  buildSignedCancelTransaction,
  finalizeWalletSignedTransaction,
  instantiateOrder,
  marketDomain,
  marketMinimum,
  orderAddresses,
  orderLockingBytecode,
  ownerLockingBytecode,
  type FundingDraft,
  type OrderParams,
  type WalletUtxo,
} from '@atprice/core';
import { ChainNetworkProvider } from '../../src/chain-provider.js';
import { migrate } from '../../src/db/migrate.js';
import { createDb, type Db } from '../../src/db/pool.js';
import { INTENT_TTL_MS, storeIntent } from '../../src/intent-store.js';
import { Keeper, type KeeperChain, type KeeperPoolFeed } from '../../src/keeper/keeper.js';
import { syncMarkets } from '../../src/markets.js';
import { paramsToJson } from '../../src/orders/model.js';
import { OrderObserver } from '../../src/orders/observe.js';
import { syncOrderAddress } from '../../src/orders/sync.js';
import { CORE_MATHS, bestPoolQuote, keeperExecuteFee } from '../../src/pools/quote.js';
import { nominationsFromIndexer, readLivePools } from '../../src/pools/reader.js';
import { silentLogger, testAnalytics } from '../support/db.js';

// The keeper against chipnet with real transactions (architecture.md: the chipnet keeper tests).
// Orders are funded and cancelled with the throwaway funder key in .local, which is never printed.
// Every broadcast is appended to .local/keeper-live-log.jsonl for internal/EVIDENCE.md.

const [MARKET] = SUPPORTED_MARKETS.chipnet;
if (MARKET === undefined) throw new Error('no chipnet market');
const TOKEN = MARKET.tokenCategory;
const SPEND = 60_000n;
const UNREACHABLE = 10n ** 15n;
const BLOCK_WAIT_MS = 15 * 60_000;
const LOG = new URL('../../../../.local/keeper-live-log.jsonl', import.meta.url);
/**
 * The chipnet dev database, migrated and never reset, so the keeper's real attempts stay inspectable
 * there. Not atprice_test: the integration suites drop that schema, and they may run concurrently.
 */
const LIVE_DATABASE_URL = process.env.LIVE_DATABASE_URL ?? 'postgres://mac@/atprice_chipnet?host=/tmp';

interface Key {
  readonly signer: SignatureTemplate;
  readonly pkh: Uint8Array;
}

const loadKey = (role: string): Key => {
  const file = JSON.parse(
    readFileSync(new URL(`../../../../.local/chipnet-${role}.json`, import.meta.url), 'utf8'),
  ) as { wif: string };
  const decoded = decodePrivateKeyWif(file.wif);
  if (typeof decoded === 'string') throw new Error(`wif for ${role} does not decode`);
  const publicKey = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  return { signer: new SignatureTemplate(file.wif), pkh: hash160(publicKey) };
};

const log = (event: Record<string, unknown>): void => {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
};

/** The keeper's order connection, with one hook on broadcast to stage a third-party pool spend. */
class InterceptingChain implements KeeperChain {
  /** Returns true when it handled (and so consumed) this broadcast. */
  beforeBroadcast: ((hex: string) => Promise<boolean>) | undefined;

  constructor(private readonly inner: ChainClient) {}

  get connected(): boolean {
    return this.inner.connected;
  }
  get endpoint(): { readonly host: string } | undefined {
    return this.inner.endpoint;
  }
  get subscriptionCount(): number {
    return this.inner.subscriptionCount;
  }
  get subscriptionsHealthy(): boolean {
    return this.inner.subscriptionsHealthy;
  }
  connect: ChainClient['connect'] = () => this.inner.connect();
  close: ChainClient['close'] = () => this.inner.close();
  onReconnect: KeeperChain['onReconnect'] = (hook) => this.inner.onReconnect(hook);
  subscribeHeaders: ChainClient['subscribeHeaders'] = (listener) => this.inner.subscribeHeaders(listener);
  subscribeAddress: ChainClient['subscribeAddress'] = (locking, listener) =>
    this.inner.subscribeAddress(locking, listener);
  retryFailedSubscriptions: ChainClient['retryFailedSubscriptions'] = () =>
    this.inner.retryFailedSubscriptions();
  getBlockHash: ChainClient['getBlockHash'] = (height) => this.inner.getBlockHash(height);
  getRawTransaction: ChainClient['getRawTransaction'] = (txid) => this.inner.getRawTransaction(txid);
  getTransactionStatus: ChainClient['getTransactionStatus'] = (txid) => this.inner.getTransactionStatus(txid);
  getHistory: ChainClient['getHistory'] = (locking) => this.inner.getHistory(locking);
  getUtxos: ChainClient['getUtxos'] = (locking) => this.inner.getUtxos(locking);
  getTip: ChainClient['getTip'] = () => this.inner.getTip();

  async broadcast(hex: string): Promise<string> {
    const hook = this.beforeBroadcast;
    if (hook !== undefined && (await hook(hex))) this.beforeBroadcast = undefined;
    return this.inner.broadcast(hex);
  }
}

interface FundedOrder {
  readonly label: string;
  readonly params: OrderParams;
  readonly txid: string;
  readonly id: string;
  readonly satoshis: bigint;
}

let db: Db;
let chain: ChainClient;
let wrapped: InterceptingChain;
let keeper: Keeper;
let observer: OrderObserver;
let provider: ChainNetworkProvider;
const indexer = new CauldronIndexerClient({ network: 'chipnet' });
const funder = loadKey('funder');
const funderLocking = binToHex(ownerLockingBytecode(funder.pkh));

/** Outpoints this suite has spent; a server can list them as unspent for a moment after a broadcast. */
const spentHere = new Set<string>();

const send = async (hex: string): Promise<string> => {
  const txid = await chain.broadcast(hex);
  const tx = decodeTransactionBch(hexToBin(hex));
  if (typeof tx !== 'string') {
    for (const input of tx.inputs)
      spentHere.add(`${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`);
  }
  return txid;
};

const walletUtxos = async (): Promise<WalletUtxo[]> =>
  (await chain.getUtxos(hexToBin(funderLocking)))
    .filter((utxo) => !spentHere.has(`${utxo.txid}:${utxo.vout}`))
    .map((utxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      lockingBytecode: funderLocking,
      pathName: 'receive' as const,
      addressIndex: 0,
      ...(utxo.token && {
        token: {
          category: utxo.token.category,
          amount: utxo.token.amount,
          ...(utxo.token.nft && {
            nft: { capability: utxo.token.nft.capability, commitment: utxo.token.nft.commitment },
          }),
        },
      }),
    }));

/** Signs a funding draft the way a wallet would: same inputs, outputs, version and locktime. */
const signDraft = (draft: FundingDraft, utxos: readonly WalletUtxo[]): string => {
  const tx = decodeTransactionBch(hexToBin(draft.unsignedHex));
  if (typeof tx === 'string') throw new Error(tx);
  const builder = new TransactionBuilder({ provider });
  for (const input of tx.inputs) {
    const txid = binToHex(input.outpointTransactionHash);
    const utxo = utxos.find((candidate) => candidate.txid === txid && candidate.vout === input.outpointIndex);
    if (utxo === undefined)
      throw new Error(`funding input ${txid}:${input.outpointIndex} is not a wallet UTXO`);
    builder.addInput(utxo, funder.signer.unlockP2PKH(), { sequence: input.sequenceNumber });
  }
  for (const output of tx.outputs) {
    builder.addOutput({
      to: output.lockingBytecode,
      amount: output.valueSatoshis,
      ...(output.token && {
        token: {
          category: binToHex(output.token.category),
          amount: output.token.amount,
          ...(output.token.nft && {
            nft: {
              capability: output.token.nft.capability,
              commitment: binToHex(output.token.nft.commitment),
            },
          }),
        },
      }),
    });
  }
  builder.setLocktime(tx.locktime);
  return finalizeWalletSignedTransaction(draft, builder.build()).hex;
};

/**
 * The suite pins the keeper to the market's deepest pool. With several pools at near-equal prices a
 * 60,000-sat fill can make another pool best, and "retried on the new pool UTXO" must be unambiguous.
 */
let poolOwner: string | undefined;

const onePool = async (tokenId: string): Promise<IndexerPool[]> =>
  (await indexer.activePools(tokenId)).filter((row) => poolOwner === undefined || row.ownerPkh === poolOwner);

const onePoolFeed = (feed: RostrumPoolClient): KeeperPoolFeed => ({
  get connected() {
    return feed.connected;
  },
  lastUpdateAt: (tokenId) => feed.lastUpdateAt(tokenId),
  poolsOf: (tokenId) => feed.poolsOf(tokenId).filter((row) => row.ownerPkh === poolOwner),
  onChange: (listener) => feed.onChange(listener),
  connect: () => feed.connect(),
  close: () => feed.close(),
  subscribe: (tokenId) => feed.subscribe(tokenId),
});

const livePools = async () =>
  (await readLivePools(chain, TOKEN, nominationsFromIndexer(await onePool(TOKEN)))).pools;

const newParams = (minOut: bigint): OrderParams => ({
  side: 'buy',
  ownerPkh: funder.pkh,
  recipientLockingBytecode: ownerLockingBytecode(funder.pkh),
  tokenCategory: TOKEN,
  minOut,
  maxNetworkFee: DEFAULT_MAX_NETWORK_FEE,
  nonce: new Uint8Array(randomBytes(8)),
});

/** minOut at 85% of the current best quote: executable now, with room for a chained second fill. */
const executableMinOut = async (): Promise<bigint> => {
  const quote = bestPoolQuote(
    CORE_MATHS,
    { side: 'buy', satoshis: SPEND + 1000n + DEFAULT_MAX_NETWORK_FEE, tokenAmount: 0n },
    await livePools(),
    keeperExecuteFee(DEFAULT_MAX_NETWORK_FEE),
  );
  if (quote === undefined) throw new Error('no chipnet pool quotes a buy');
  const minOut = (quote.recipientAmount * 85n) / 100n;
  return minOut > 0n ? minOut : 1n;
};

/**
 * Buy funding pays sats only from token-free UTXOs (architecture.md, order creation step 5). When the
 * funder's sats sit on a token UTXO, split it once: tokens back to the funder on a dust-plus output,
 * and token-free outputs for the fundings and cancels.
 */
const ensureTokenFreeSats = async (needed: bigint): Promise<void> => {
  const utxos = await walletUtxos();
  const free = utxos
    .filter((utxo) => utxo.token === undefined)
    .reduce((sum, utxo) => sum + utxo.satoshis, 0n);
  if (free >= needed) return;
  const source = utxos
    .filter((utxo) => utxo.token !== undefined && utxo.token.nft === undefined)
    .sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
  const fee = 2_000n;
  const piece = 200_000n;
  const pieces = needed / piece + 1n;
  if (source?.token === undefined || source.satoshis < pieces * piece + 1_000n + fee)
    throw new Error('the funder holds too few satoshis for the live keeper suite');
  const builder = new TransactionBuilder({ provider });
  builder.addInput(source, funder.signer.unlockP2PKH());
  builder.addOutput({
    to: hexToBin(funderLocking),
    amount: 1_000n,
    token: { category: source.token.category, amount: source.token.amount },
  });
  for (let index = 0n; index < pieces; index += 1n)
    builder.addOutput({ to: hexToBin(funderLocking), amount: piece });
  builder.addOutput({
    to: hexToBin(funderLocking),
    amount: source.satoshis - 1_000n - pieces * piece - fee,
  });
  const txid = await send(builder.build());
  log({ label: 'wallet-split', kind: 'split', txid });
};

const fund = async (label: string, params: OrderParams): Promise<FundedOrder> => {
  const utxos = await walletUtxos();
  const draft = buildFundingTransaction({
    params,
    amount: SPEND,
    minimumAmount: marketMinimum(MARKET, 'buy'),
    walletUtxos: utxos,
    network: 'chipnet',
    provider,
  });
  const txid = await send(signDraft(draft, utxos));
  log({ label, kind: 'funding', txid, orderAddress: draft.orderAddress, minOut: params.minOut.toString() });
  return { label, params, txid, id: `${txid}:0`, satoshis: draft.funding.satoshis };
};

const orderUtxo = (order: FundedOrder): Utxo => ({
  txid: order.txid,
  vout: 0,
  satoshis: order.satoshis,
  lockingBytecode: binToHex(orderLockingBytecode(order.params)),
});

const cancel = async (order: FundedOrder): Promise<string> => {
  const ownerUtxo = (await walletUtxos()).find((utxo) => utxo.token === undefined);
  if (ownerUtxo === undefined) throw new Error('the funder holds no token-free UTXO for cancel input 0');
  const signed = buildSignedCancelTransaction({
    owner: { utxos: [ownerUtxo] },
    orders: [{ order: instantiateOrder(order.params, provider), utxo: orderUtxo(order) }],
    ownerSigner: funder.signer,
  });
  const txid = await send(signed.hex);
  log({ label: order.label, kind: 'cancel', txid, orderId: order.id });
  return txid;
};

const record = async (order: FundedOrder): Promise<void> => {
  await syncOrderAddress(db, observer, order.params, {
    sweep: false,
    reason: 'registered',
    analytics: testAnalytics,
  });
};

const waitFor = async <T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs = BLOCK_WAIT_MS,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
};

const confirmed = (txid: string) => async (): Promise<true | undefined> =>
  (await chain.getTransactionStatus(txid)).confirmations > 0 ? true : undefined;

const statusOf = async (id: string): Promise<string | undefined> =>
  (await db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id])).rows[0]?.status;

const statusIs = (id: string, wanted: string) => async (): Promise<true | undefined> =>
  (await statusOf(id)) === wanted ? true : undefined;

const transitions = async (id: string): Promise<string[]> =>
  (
    await db.query<{ from_status: string | null; to_status: string | null; decision: string }>(
      `SELECT from_status, to_status, decision FROM transaction_events WHERE order_id = $1 ORDER BY id`,
      [id],
    )
  ).rows
    .filter((row) => row.decision === 'transition')
    .map((row) => `${row.from_status ?? '(none)'}->${row.to_status ?? '(deleted)'}`);

interface AttemptRow {
  readonly id: string;
  readonly order_id: string;
  readonly outcome: string;
  readonly txid: string | null;
  readonly pool_outpoint: string | null;
  readonly chained_from: string | null;
}

const attemptsOf = async (orderId: string): Promise<AttemptRow[]> =>
  (
    await db.query<AttemptRow>(
      `SELECT id, order_id, outcome, txid, pool_outpoint, chained_from FROM keeper_attempts
        WHERE order_id = $1 ORDER BY started_at`,
      [orderId],
    )
  ).rows;

// Funded in beforeAll and confirmed before the keeper boots.
let first: FundedOrder;
let second: FundedOrder;
let retried: FundedOrder;
let thirdParty: FundedOrder;
let cancelAfterConfirm: FundedOrder;

describe('keeper on chipnet (real transactions)', () => {
  beforeAll(async () => {
    db = createDb(LIVE_DATABASE_URL, 'atprice-keeper-live-test');
    await migrate(db);
    await syncMarkets(db, 'chipnet');
    chain = createNodeChainClient('chipnet', { application: 'atprice-keeper-live' });
    await chain.connect();
    provider = new ChainNetworkProvider(chain, 'chipnet');
    observer = new OrderObserver(chain, 'chipnet', marketDomain('chipnet'));

    const deepest = (await livePools()).reduce((a, b) => (a.reserves.sats >= b.reserves.sats ? a : b));
    poolOwner = deepest.ownerPkhHex;
    log({ label: 'pool', kind: 'pinned', pool: deepest.outpoint, ownerPkh: poolOwner });
    await ensureTokenFreeSats(1_000_000n);
    first = await fund('two-in-one-sweep:first', newParams(await executableMinOut()));
    second = await fund('two-in-one-sweep:second', newParams(await executableMinOut()));
    retried = await fund('pool-spent-retry:order', newParams(await executableMinOut()));
    thirdParty = await fund('pool-spent-retry:third-party', newParams(1n));
    cancelAfterConfirm = await fund('cancel-after-confirm', newParams(UNREACHABLE));
    for (const order of [first, second, retried, thirdParty, cancelAfterConfirm]) {
      await waitFor(confirmed(order.txid), `${order.label} funding to confirm`);
    }
    // Registered as the API would, so the keeper boots with them OPEN; the retry order and the
    // third party's order stay unknown to the keeper for now.
    for (const order of [first, second, cancelAfterConfirm]) {
      await record(order);
      expect(await statusOf(order.id)).toBe('OPEN');
    }

    const orders = createNodeChainClient('chipnet', { application: 'atprice-keeper-live-orders' });
    wrapped = new InterceptingChain(orders);
    keeper = new Keeper({
      db,
      databaseUrl: LIVE_DATABASE_URL,
      network: 'chipnet',
      chain: wrapped,
      intentChain: createNodeChainClient('chipnet', { application: 'atprice-keeper-live-intents' }),
      rostrum: onePoolFeed(createNodeRostrumClient('chipnet')),
      indexerClient: { activePools: onePool },
      cauldronBroadcast: null,
      sweepIntervalMs: 30_000,
      keeperId: 'keeper-live-test',
      logger: silentLogger,
      analytics: testAnalytics,
    });
    await keeper.start();
  }, 30 * 60_000);

  afterAll(async () => {
    await keeper?.stop();
    await chain?.close();
    await db?.end();
  });

  it('fills two executable orders on one pool within one run, the second chained on the first fill', async () => {
    const [firstAttempt] = await waitFor(
      async () => {
        const rows = await attemptsOf(first.id);
        return rows.some((row) => row.outcome === 'broadcast_ok') ? rows : undefined;
      },
      'the first fill',
      120_000,
    );
    const secondRows = await waitFor(
      async () => {
        const rows = await attemptsOf(second.id);
        return rows.some((row) => row.outcome === 'broadcast_ok') ? rows : undefined;
      },
      'the second fill',
      120_000,
    );
    const secondAttempt = secondRows.find((row) => row.outcome === 'broadcast_ok');
    log({
      label: 'two-in-one-sweep',
      kind: 'executes',
      first: { orderId: first.id, txid: firstAttempt?.txid, pool: firstAttempt?.pool_outpoint },
      second: { orderId: second.id, txid: secondAttempt?.txid, pool: secondAttempt?.pool_outpoint },
    });
    expect(firstAttempt?.outcome).toBe('broadcast_ok');
    expect(secondAttempt?.chained_from).toBe(firstAttempt?.id);
    expect(secondAttempt?.pool_outpoint).toBe(`${firstAttempt?.txid}:0`);
    for (const order of [first, second]) {
      await waitFor(
        async () => ((await transitions(order.id)).includes('OPEN->EXECUTION_PENDING') ? true : undefined),
        `${order.label} to reach EXECUTION_PENDING`,
        120_000,
      );
    }
  });

  it('retries on the new pool UTXO after a third party spends the pool between build and broadcast', async () => {
    // #given the third party's own execute staged just before the keeper's broadcast, on the same pool
    let thirdPartyTxid: string | undefined;
    wrapped.beforeBroadcast = async (hex) => {
      const tx = decodeTransactionBch(hexToBin(hex));
      if (typeof tx === 'string') return false;
      const spendsOrder = tx.inputs.some(
        (input) => binToHex(input.outpointTransactionHash) === retried.txid && input.outpointIndex === 0,
      );
      if (!spendsOrder) return false;
      const { rows } = await db.query<{ pool_outpoint: string; pool_owner_pkh: string }>(
        `SELECT pool_outpoint, pool_owner_pkh FROM keeper_attempts WHERE order_id = $1 AND outcome = 'built'`,
        [retried.id],
      );
      const built = rows[0];
      if (built === undefined) throw new Error('no built attempt row before the broadcast');
      const pool = (
        await readLivePools(chain, TOKEN, [{ ownerPkh: built.pool_owner_pkh, outpoint: built.pool_outpoint }])
      ).pools.find((candidate) => candidate.outpoint === built.pool_outpoint);
      if (pool === undefined) throw new Error(`pool ${built.pool_outpoint} is not live`);
      const execute = buildExecuteTransaction(
        instantiateOrder(thirdParty.params, provider),
        orderUtxo(thirdParty),
        pool,
        { fee: { kind: 'absolute', satoshis: keeperExecuteFee(thirdParty.params.maxNetworkFee) } },
      );
      thirdPartyTxid = await send(execute.hex);
      log({
        label: 'pool-spent-retry',
        kind: 'third-party-execute',
        txid: thirdPartyTxid,
        pool: pool.outpoint,
      });
      return true;
    };

    // #when the order is registered and the keeper sweeps
    await record(retried);
    await keeper.sweep();

    // #then the first attempt is pool_spent, and the retry fills on the third party's pool output
    const rows = await waitFor(
      async () => {
        const attempts = await attemptsOf(retried.id);
        return attempts.some((row) => row.outcome === 'broadcast_ok') ? attempts : undefined;
      },
      'the retried fill',
      180_000,
    );
    const ok = rows.find((row) => row.outcome === 'broadcast_ok');
    log({
      label: 'pool-spent-retry',
      kind: 'attempts',
      orderId: retried.id,
      outcomes: rows.map((row) => row.outcome),
      retryTxid: ok?.txid,
      retryPool: ok?.pool_outpoint,
    });
    expect(rows[0]?.outcome).toBe('pool_spent');
    expect(thirdPartyTxid).toBeDefined();
    expect(ok?.pool_outpoint).toBe(`${thirdPartyTxid}:0`);
  });

  it('observes FUNDING_PENDING -> CANCELLATION_PENDING -> CANCELLED for a cancel sent before the funding confirms', async () => {
    // #given an intent the keeper is watching (API insert, NOTIFY handoff)
    const params = newParams(UNREACHABLE);
    const addresses = orderAddresses(params, 'chipnet');
    const stored = await storeIntent(db, {
      network: 'chipnet',
      orderAddress: addresses.address,
      orderLockingBytecode: binToHex(addresses.lockingBytecode),
      side: 'buy',
      tokenId: TOKEN,
      amount: SPEND.toString(),
      params: paramsToJson(params),
      clientPrefix: '127.0.0.1',
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    });
    expect(stored.kind).toBe('stored');
    await waitFor(
      async () => (keeper.intents.watchedCount > 0 ? true : undefined),
      'the intent watch',
      30_000,
    );

    // #when the order is funded, seen pending, then cancelled before any block
    const order = await fund('cancel-before-confirm', params);
    await waitFor(statusIs(order.id, 'FUNDING_PENDING'), 'the keeper to see the funding', 60_000);
    const cancelTxid = await cancel(order);

    // #then
    await waitFor(statusIs(order.id, 'CANCELLATION_PENDING'), 'the keeper to see the cancel', 60_000);
    await waitFor(statusIs(order.id, 'CANCELLED'), 'the cancel to confirm');
    const { rows } = await db.query<{ funding_height: number; spend_height: number }>(
      'SELECT funding_height, spend_height FROM orders WHERE id = $1',
      [order.id],
    );
    log({ label: 'cancel-before-confirm', kind: 'result', orderId: order.id, cancelTxid, ...rows[0] });
    expect(await transitions(order.id)).toEqual([
      '(none)->FUNDING_PENDING',
      'FUNDING_PENDING->CANCELLATION_PENDING',
      'CANCELLATION_PENDING->CANCELLED',
    ]);
  });

  it('cancels an order whose funding confirmed in an earlier block than the cancel', async () => {
    // #given an OPEN order funded blocks ago
    expect(await statusOf(cancelAfterConfirm.id)).toBe('OPEN');

    // #when
    const cancelTxid = await cancel(cancelAfterConfirm);

    // #then
    await waitFor(statusIs(cancelAfterConfirm.id, 'CANCELLED'), 'the cancel to confirm');
    const { rows } = await db.query<{ funding_height: number; spend_height: number }>(
      'SELECT funding_height, spend_height FROM orders WHERE id = $1',
      [cancelAfterConfirm.id],
    );
    const heights = rows[0];
    log({
      label: 'cancel-after-confirm',
      kind: 'result',
      orderId: cancelAfterConfirm.id,
      cancelTxid,
      ...heights,
    });
    expect(heights?.funding_height).toBeLessThan(heights?.spend_height ?? 0);
    expect(await transitions(cancelAfterConfirm.id)).toEqual([
      '(none)->OPEN',
      'OPEN->CANCELLATION_PENDING',
      'CANCELLATION_PENDING->CANCELLED',
    ]);
  });
});
