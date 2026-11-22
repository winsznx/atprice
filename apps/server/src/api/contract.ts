import { decodeTransactionBch, hexToBin } from '@bitauth/libauth';
import type { Network } from '@atprice/core';
import type { Queryable } from '../db/pool.js';
import { FACT, readFacts } from '../facts.js';
import type { OrderRow } from '../orders/model.js';
import type { ChainReader } from '../orders/observe.js';
import { addressOfLocking, orderJson, type AttemptRow, type ExecutionRow } from './serialize.js';

/*
 * Response bodies in the shape the web client parses (`@atprice/api-schema`, the API contract).
 * Older fields stay alongside where they don't collide, so operators' scripts keep working.
 */

const outpoint = (id: string | null | undefined): { txid: string; vout: number } | null => {
  if (typeof id !== 'string') return null;
  const [txid, vout] = id.split(':');
  return txid === undefined || vout === undefined ? null : { txid, vout: Number(vout) };
};

const confirmations = (tip: number | null, height: number | null): number =>
  tip === null || height === null || height > tip ? 0 : tip - height + 1;

/** The keeper's recorded tip height, the one every confirmation count is measured against. */
export const recordedTip = async (db: Queryable, network: Network): Promise<number | null> => {
  const value = (await readFacts(db, network)).get(FACT.header)?.value as { height?: unknown } | undefined;
  return typeof value?.height === 'number' ? value.height : null;
};

/** `v1:<fingerprint>` -> 1. */
const contractVersionNumber = (stored: string): number => {
  const match = /^v(\d+)/.exec(stored);
  return match?.[1] === undefined ? 1 : Number(match[1]);
};

const orderAmount = (row: OrderRow): string =>
  row.input_amount ?? (row.side === 'buy' ? row.satoshis : row.token_amount);

const keeperOutcome = (evaluation: Record<string, unknown>): string => {
  if (evaluation.executable === true) return 'executable';
  return evaluation.output === null ? 'no_pool' : 'below_minimum';
};

const keeperCheck = (row: OrderRow) => {
  const evaluation = row.last_evaluation as Record<string, unknown> | null;
  if (evaluation === null || row.last_evaluated_at === null) return null;
  return {
    checkedAt: row.last_evaluated_at.toISOString(),
    poolOutpoint: outpoint(evaluation.poolOutpoint as string | null),
    bestOutput: typeof evaluation.output === 'string' ? evaluation.output : null,
    outcome: keeperOutcome(evaluation),
  };
};

/*
 * Cauldron pools charge 0.3% on the BCH side of a trade and keep it in the pool, so the fee is
 * recovered from the pool's satoshi movement rather than stored.
 */
const CAULDRON_FEE_PER_MILLE = 3n;
const poolFeeSats = (route: Record<string, unknown>): string => {
  const before = typeof route.poolSatsBefore === 'string' ? BigInt(route.poolSatsBefore) : 0n;
  const after = typeof route.poolSatsAfter === 'string' ? BigInt(route.poolSatsAfter) : before;
  const moved = after > before ? after - before : before - after;
  return ((moved * CAULDRON_FEE_PER_MILLE) / 1000n).toString();
};

/** The settlement fields of an execution, shared by an order's `settlement` and `/executions/:id`. */
const fillFields = (row: ExecutionRow, tip: number | null) => {
  const route = row.route_metadata;
  return {
    txid: row.txid,
    blockHeight: row.status === 'confirmed' ? row.block_height : null,
    confirmations: row.status === 'confirmed' ? confirmations(tip, row.block_height) : 0,
    // Buy: token units delivered. Sell: the payout output, proceeds plus the 2,000 sat reserve.
    received: row.side === 'buy' ? row.output_amount : row.payout_satoshis,
    surplus: row.surplus,
    poolOutpoint: outpoint(route.poolOutpoint as string | undefined) ?? { txid: row.txid, vout: 0 },
    poolPkh: typeof route.poolOwnerPkh === 'string' ? route.poolOwnerPkh : '',
    poolFeeSats: poolFeeSats(route),
    networkFeeSats: row.network_fee,
    filledBy: row.by_atprice_keeper ? ('atprice_keeper' as const) : ('other' as const),
  };
};

export const executionContract = (row: ExecutionRow, tip: number | null) => ({
  ...fillFields(row, tip),
  orderId: row.order_id,
  side: row.side,
  amountIn: row.input_amount,
  observedAt: (row.confirmed_at ?? row.created_at).toISOString(),
});

export const attemptContract = (row: AttemptRow) => ({
  id: row.id,
  createdAt: row.started_at.toISOString(),
  outcome: row.outcome,
  reason: row.failure_reason,
  txid: row.txid,
  poolOutpoint: outpoint(row.pool_outpoint),
});

/** A cancel's network fee: inputs minus outputs, read from the transaction and its previous outputs. */
const cancelNetworkFee = async (chain: ChainReader, txid: string): Promise<bigint> => {
  const decode = async (id: string) => {
    const decoded = decodeTransactionBch(hexToBin(await chain.getRawTransaction(id)));
    if (typeof decoded === 'string') throw new Error(`transaction ${id} does not decode: ${decoded}`);
    return decoded;
  };
  const transaction = await decode(txid);
  let inputs = 0n;
  for (const input of transaction.inputs) {
    const previous = await decode(Buffer.from(input.outpointTransactionHash).toString('hex'));
    inputs += previous.outputs[input.outpointIndex]?.valueSatoshis ?? 0n;
  }
  const outputs = transaction.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  return inputs - outputs;
};

interface OrderContext {
  readonly tip: number | null;
  readonly firstSeen: Map<string, Date>;
  readonly executions: Map<string, ExecutionRow>;
  readonly cancelFees: Map<string, bigint>;
}

const loadContext = async (
  db: Queryable,
  chain: ChainReader,
  network: Network,
  rows: readonly OrderRow[],
): Promise<OrderContext> => {
  const ids = rows.map((row) => row.id);
  const { rows: seen } = await db.query<{ order_id: string; txid: string; first: Date }>(
    `SELECT order_id, txid, min(observed_at) AS first FROM transaction_events
      WHERE order_id = ANY($1::text[]) AND txid IS NOT NULL GROUP BY order_id, txid`,
    [ids],
  );
  const { rows: executions } = await db.query<ExecutionRow>(
    `SELECT * FROM executions WHERE order_id = ANY($1::text[])`,
    [ids],
  );
  const cancelFees = new Map<string, bigint>();
  for (const row of rows) {
    if (row.spend_kind === 'cancel' && row.spend_txid !== null) {
      cancelFees.set(row.spend_txid, await cancelNetworkFee(chain, row.spend_txid));
    }
  }
  return {
    tip: await recordedTip(db, network),
    firstSeen: new Map(seen.map((entry) => [`${entry.order_id}/${entry.txid}`, entry.first])),
    executions: new Map(executions.map((entry) => [entry.txid, entry])),
    cancelFees,
  };
};

const transactionEvents = (row: OrderRow, ctx: OrderContext) => {
  const event = (
    txid: string,
    kind: 'funding' | 'execute' | 'cancel' | 'unknown_spend',
    height: number | null,
    blockHash: string | null,
    fallbackSeen: Date,
  ) => ({
    txid,
    kind,
    firstSeenAt: (ctx.firstSeen.get(`${row.id}/${txid}`) ?? fallbackSeen).toISOString(),
    confirmations: confirmations(ctx.tip, height),
    blockHeight: height,
    blockHash,
    networkState: height === null ? ('seen' as const) : ('confirmed' as const),
    conflict: null,
  });
  const events = [
    event(row.funding_txid, 'funding', row.funding_height, row.funding_block_hash, row.created_at),
  ];
  if (row.spend_txid !== null) {
    const kind = row.spend_kind === 'unknown' ? 'unknown_spend' : (row.spend_kind ?? 'unknown_spend');
    events.push(event(row.spend_txid, kind, row.spend_height, row.spend_block_hash, row.updated_at));
  }
  return events;
};

const settlement = (row: OrderRow, ctx: OrderContext) => {
  if (row.spend_txid === null) return null;
  if (row.spend_kind === 'execute') {
    const execution = ctx.executions.get(row.spend_txid);
    return execution === undefined ? null : { kind: 'fill' as const, ...fillFields(execution, ctx.tip) };
  }
  if (row.spend_kind === 'cancel') {
    return {
      kind: 'cancel' as const,
      txid: row.spend_txid,
      blockHeight: row.spend_height,
      confirmations: confirmations(ctx.tip, row.spend_height),
      // The owner's own UTXO pays the cancel fee, so the whole order value comes back.
      refundSats: row.satoshis,
      refundTokens: row.token_amount,
      networkFeeSats: (ctx.cancelFees.get(row.spend_txid) ?? 0n).toString(),
      refundAddress: row.owner_address,
      authorizedBy: 'cancel' as const,
    };
  }
  return null;
};

const orderContract = (row: OrderRow, ctx: OrderContext) => {
  const legacy = orderJson(row);
  return {
    ...legacy,
    contractFingerprint: legacy.contractVersion,
    funding: { ...legacy.funding, txid: row.funding_txid, vout: row.funding_vout },
    tokenCategory: row.token_id,
    amount: orderAmount(row),
    recipientAddress: addressOfLocking(row.recipient_locking_bytecode, row.network, row.side === 'buy') ?? '',
    contractVersion: contractVersionNumber(row.contract_version),
    contractAddress: row.order_address,
    events: transactionEvents(row, ctx),
    keeperCheck: keeperCheck(row),
    settlement: settlement(row, ctx),
  };
};

export type OrderContract = ReturnType<typeof orderContract>;

export const ordersContract = async (
  db: Queryable,
  chain: ChainReader,
  network: Network,
  rows: readonly OrderRow[],
): Promise<OrderContract[]> => {
  const ctx = await loadContext(db, chain, network, rows);
  return rows.map((row) => orderContract(row, ctx));
};

/** The block a transaction confirmed in, timed by when AtPrice first saw it confirmed. */
export const blockTimes = async (
  db: Queryable,
  network: string,
  txids: readonly string[],
): Promise<Map<string, Date>> => {
  const { rows } = await db.query<{ txid: string; first: Date }>(
    `SELECT txid, min(observed_at) AS first FROM transaction_events
      WHERE network = $1 AND txid = ANY($2::text[]) AND block_height IS NOT NULL GROUP BY txid`,
    [network, txids],
  );
  return new Map(rows.map((row) => [row.txid, row.first]));
};
