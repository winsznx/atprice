import type { ChainToken, ChainUtxo } from '@atprice/chain';
import {
  bytesEqual,
  classifyOrderSpend,
  decodeTransactionHex,
  findMarket,
  orderAddresses,
  type MarketDefinition,
  type Network,
  type OrderRecord,
  type OrderSpend,
  type SpentOrderOutput,
} from '@atprice/core';
import { binToHex, encodeLockingBytecodeP2pkh, type Output, type TransactionCommon } from '@bitauth/libauth';
import { RecoverError } from './errors';
import { scanRecords } from './record';
import type { RecoverChain } from './server';

export interface Outpoint {
  readonly txid: string;
  readonly vout: number;
}

/** A value held by an output, in the chain package's display encoding (hex category and commitment). */
export interface HeldValue {
  readonly satoshis: bigint;
  readonly token?: ChainToken;
}

export type OrderChainStatus =
  | { readonly kind: 'unspent'; readonly utxo: ChainUtxo }
  | {
      readonly kind: 'filled';
      readonly txid: string;
      /** Block height, 0 or below while in the mempool (Electrum convention). */
      readonly height: number;
      readonly spend: Extract<OrderSpend, { path: 'execute' }>;
      readonly pool: Outpoint;
    }
  | {
      readonly kind: 'cancelled';
      readonly txid: string;
      readonly height: number;
      readonly authorization: 'cancel' | 'cancelWithSig';
      readonly refund: HeldValue;
    }
  | {
      readonly kind: 'needs_review';
      readonly txid: string;
      readonly height: number;
      readonly reason: string;
    };

/** An order rebuilt from its funding transaction alone (recover.md hard rule 5). */
export interface LoadedOrder {
  readonly network: Network;
  readonly funding: Outpoint;
  readonly record: OrderRecord;
  readonly recordHex: string;
  /** From the allowlist bundled in `packages/core`; undefined for a category not on it (id only). */
  readonly market: MarketDefinition | undefined;
  readonly lockingBytecode: Uint8Array;
  readonly address: string;
  readonly tokenAddress: string;
  readonly fundingOutput: HeldValue;
  /** Height of the funding transaction, 0 or below while unconfirmed. */
  readonly fundingHeight: number;
  readonly status: OrderChainStatus;
}

export type TxidLookup =
  | { readonly kind: 'order'; readonly order: LoadedOrder }
  | { readonly kind: 'no_record' }
  | {
      readonly kind: 'unknown_version';
      readonly version: number;
      readonly txid: string;
      readonly recordHex: string;
    };

export const heldValue = (output: Output): HeldValue => {
  const token = output.token;
  if (token === undefined) return { satoshis: output.valueSatoshis };
  return {
    satoshis: output.valueSatoshis,
    token: {
      category: binToHex(token.category),
      amount: token.amount,
      ...(token.nft && {
        nft: { capability: token.nft.capability, commitment: binToHex(token.nft.commitment) },
      }),
    },
  };
};

const spentOutput = (value: HeldValue): SpentOrderOutput => ({
  satoshis: value.satoshis,
  ...(value.token && {
    token: {
      category: value.token.category,
      amount: value.token.amount,
      ...(value.token.nft && { nft: value.token.nft }),
    },
  }),
});

const SPEND_REASON: Readonly<Record<Extract<OrderSpend, { path: 'unknown' }>['reason'], string>> = {
  not_order_redeem_script: 'the input does not carry this order’s contract',
  unknown_function: 'the input calls no known contract function',
  malformed_unlocking: 'the input’s unlocking script does not decode',
  execute_shape: 'it calls execute() but its outputs are not a valid fill',
  cancel_shape: 'it calls a cancel function but its refund breaks the contract’s refund rule',
};

const spendingInput = (transaction: TransactionCommon, outpoint: Outpoint): number =>
  transaction.inputs.findIndex(
    (input) =>
      binToHex(input.outpointTransactionHash) === outpoint.txid && input.outpointIndex === outpoint.vout,
  );

/**
 * The order output's state, from the contract's own unspent list and history. A spend is classified
 * by its function selector and re-verified by `classifyOrderSpend` in `packages/core`.
 */
export const readOrderStatus = async (
  chain: RecoverChain,
  record: OrderRecord,
  lockingBytecode: Uint8Array,
  funding: Outpoint,
  fundingOutput: HeldValue,
): Promise<{ status: OrderChainStatus; fundingHeight: number }> => {
  const [utxos, history] = await Promise.all([
    chain.getUtxos(lockingBytecode),
    chain.getHistory(lockingBytecode),
  ]);
  const utxo = utxos.find((entry) => entry.txid === funding.txid && entry.vout === funding.vout);
  const fundingHeight = history.find((entry) => entry.txid === funding.txid)?.height ?? utxo?.height ?? 0;
  if (utxo !== undefined) return { status: { kind: 'unspent', utxo }, fundingHeight };

  const later = history.filter((entry) => entry.txid !== funding.txid);
  for (const entry of later) {
    const transaction = decodeTransactionHex(await chain.getRawTransaction(entry.txid));
    const inputIndex = spendingInput(transaction, funding);
    if (inputIndex < 0) continue;
    const spend = classifyOrderSpend(transaction, inputIndex, record, spentOutput(fundingOutput));
    if (spend.path === 'execute') {
      const poolInput = transaction.inputs[0];
      const pool = {
        txid: poolInput === undefined ? '' : binToHex(poolInput.outpointTransactionHash),
        vout: poolInput?.outpointIndex ?? 0,
      };
      return {
        status: { kind: 'filled', txid: entry.txid, height: entry.height, spend, pool },
        fundingHeight,
      };
    }
    if (spend.path === 'cancel') {
      const refund = transaction.outputs[spend.refundVout];
      if (refund === undefined) break;
      return {
        status: {
          kind: 'cancelled',
          txid: entry.txid,
          height: entry.height,
          authorization: spend.authorization,
          refund: heldValue(refund),
        },
        fundingHeight,
      };
    }
    return {
      status: {
        kind: 'needs_review',
        txid: entry.txid,
        height: entry.height,
        reason: SPEND_REASON[spend.reason],
      },
      fundingHeight,
    };
  }
  throw new RecoverError(
    'RECOVER_SPEND_NOT_FOUND',
    'This server lists the order output as spent but shows no transaction that spends it. Try another server.',
  );
};

/** Rebuilds the order from a decoded funding transaction that carries a valid record. */
const loadFromFunding = async (
  chain: RecoverChain,
  network: Network,
  txid: string,
  transaction: TransactionCommon,
  record: OrderRecord,
  recordHex: string,
): Promise<LoadedOrder> => {
  const addresses = orderAddresses(record, network);
  const vout = transaction.outputs.findIndex((output) =>
    bytesEqual(output.lockingBytecode, addresses.lockingBytecode),
  );
  const output = transaction.outputs[vout];
  if (output === undefined) {
    throw new RecoverError(
      'RECOVER_DERIVATION_MISMATCH',
      "The contract address rebuilt from this record doesn't hold the funds. The record may be malformed. Code: RECOVER_DERIVATION_MISMATCH.",
    );
  }
  const funding = { txid, vout };
  const fundingOutput = heldValue(output);
  const { status, fundingHeight } = await readOrderStatus(
    chain,
    record,
    addresses.lockingBytecode,
    funding,
    fundingOutput,
  );
  return {
    network,
    funding,
    record,
    recordHex,
    market: findMarket(network, record.tokenCategory),
    lockingBytecode: addresses.lockingBytecode,
    address: addresses.address,
    tokenAddress: addresses.tokenAddress,
    fundingOutput,
    fundingHeight,
    status,
  };
};

/** Fetches a funding transaction from the chosen server and rebuilds its order locally. */
export const findOrderByTxid = async (
  chain: RecoverChain,
  network: Network,
  txid: string,
): Promise<TxidLookup> => {
  const transaction = decodeTransactionHex(await chain.getRawTransaction(txid));
  const scan = scanRecords(transaction);
  switch (scan.kind) {
    case 'none':
      return { kind: 'no_record' };
    case 'unknown_version':
      return { kind: 'unknown_version', version: scan.version, txid, recordHex: scan.recordHex };
    case 'invalid':
      throw new RecoverError(
        'RECOVER_RECORD_INVALID',
        `This transaction carries an AtPrice record that doesn't decode (${scan.reason}). Nothing can be rebuilt from it.`,
      );
    case 'record':
      return {
        kind: 'order',
        order: await loadFromFunding(chain, network, txid, transaction, scan.record, scan.recordHex),
      };
  }
};

export interface AddressSearch {
  readonly orders: readonly LoadedOrder[];
  /** Records of contract versions this file doesn't include; their owner can't be read here. */
  readonly unknownVersions: readonly number[];
}

export type SearchProgress = (checked: number, total: number) => void;

const SEARCH_CONCURRENCY = 4;

/**
 * Every order an owner address holds. Each AtPrice funding pays output 2 to the owner address, so its
 * history contains every funding; only records whose `ownerPkh` is this address are kept.
 */
export const findOrdersByAddress = async (
  chain: RecoverChain,
  network: Network,
  ownerPkh: Uint8Array,
  onProgress: SearchProgress,
): Promise<AddressSearch> => {
  const history = await chain.getHistory(encodeLockingBytecodeP2pkh(ownerPkh));
  const txids = [...new Set(history.map((entry) => entry.txid))];
  const found: { txid: string; transaction: TransactionCommon; record: OrderRecord; recordHex: string }[] =
    [];
  const unknownVersions = new Set<number>();
  let checked = 0;
  onProgress(0, txids.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < txids.length) {
      const txid = txids[next];
      next += 1;
      if (txid === undefined) continue;
      const transaction = decodeTransactionHex(await chain.getRawTransaction(txid));
      const scan = scanRecords(transaction);
      if (scan.kind === 'record' && bytesEqual(scan.record.ownerPkh, ownerPkh)) {
        found.push({ txid, transaction, record: scan.record, recordHex: scan.recordHex });
      } else if (scan.kind === 'unknown_version') {
        unknownVersions.add(scan.version);
      }
      checked += 1;
      onProgress(checked, txids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, txids.length) }, worker));
  const order = new Map(txids.map((txid, index) => [txid, index]));
  found.sort((a, b) => (order.get(b.txid) ?? 0) - (order.get(a.txid) ?? 0));
  const orders: LoadedOrder[] = [];
  for (const entry of found) {
    orders.push(
      await loadFromFunding(chain, network, entry.txid, entry.transaction, entry.record, entry.recordHex),
    );
  }
  return { orders, unknownVersions: [...unknownVersions].sort((a, b) => a - b) };
};

/** Confirmations of a transaction at `height` with the server's tip at `tip`; 0 while unconfirmed. */
export const confirmationsAt = (height: number, tip: number): number =>
  height > 0 ? Math.max(0, tip - height + 1) : 0;
