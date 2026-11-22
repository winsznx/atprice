import {
  binToHex,
  decodeTransactionCommon,
  encodeLockingBytecodeP2pkh,
  encodeTransactionCommon,
  hashTransactionUiOrder,
  hexToBin,
} from '@bitauth/libauth';
import {
  encodeOrderRecord,
  orderLockingBytecode,
  ownerLockingBytecode,
  type OrderParams,
} from '@atprice/core';
import { describe, expect, it } from 'vitest';
import type { ChainAccess, ChainUtxo } from '@/lib/chain/types';
import { CHIPNET_MARKET } from '@/components/orders/test-fixtures';
import { buildOwnerCancel, buildSignatureCancel, readOrderFromChain } from './cancel-build';
import { checkCancelRules, compareWithServer } from './cancel-rules';

const OWNER_PKH = new Uint8Array(20).fill(7);
const SPEND = 50_000n;
const MAX_FEE = 2_000n;
const ORDER_VALUE = SPEND + 1_000n + MAX_FEE;

const params: OrderParams = {
  side: 'buy',
  ownerPkh: OWNER_PKH,
  recipientLockingBytecode: ownerLockingBytecode(OWNER_PKH),
  tokenCategory: CHIPNET_MARKET.tokenCategory,
  minOut: 1_000n,
  maxNetworkFee: MAX_FEE,
  nonce: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
};

const ownerLocking = encodeLockingBytecodeP2pkh(OWNER_PKH);
const orderLocking = orderLockingBytecode(params);

/** A funding transaction shaped as contract.md prescribes: order, record, owner change. */
const fundingBytes = encodeTransactionCommon({
  version: 2,
  locktime: 0,
  inputs: [
    {
      outpointTransactionHash: new Uint8Array(32).fill(0x11),
      outpointIndex: 0,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: new Uint8Array(),
    },
  ],
  outputs: [
    { lockingBytecode: orderLocking, valueSatoshis: ORDER_VALUE },
    { lockingBytecode: encodeOrderRecord(params), valueSatoshis: 0n },
    { lockingBytecode: ownerLocking, valueSatoshis: 1_000n },
  ],
});
const FUNDING_HEX = binToHex(fundingBytes);
const FUNDING_TXID = binToHex(hashTransactionUiOrder(fundingBytes));

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => binToHex(a) === binToHex(b);

/** A chain double: the order UTXO and the owner's coins, as Electrum would list them. */
const fakeChain = ({
  orderUnspent = true,
  ownerCoins = [{ txid: FUNDING_TXID, vout: 2, satoshis: 1_000n, height: 1 }],
}: { orderUnspent?: boolean; ownerCoins?: ChainUtxo[] } = {}): ChainAccess => ({
  endpointLabel: 'test:50004',
  getRawTransaction: async (txid) => {
    if (txid !== FUNDING_TXID) throw new Error(`unknown transaction ${txid}`);
    return FUNDING_HEX;
  },
  getUtxos: async (locking) => {
    if (sameBytes(locking, orderLocking)) {
      return orderUnspent ? [{ txid: FUNDING_TXID, vout: 0, satoshis: ORDER_VALUE, height: 1 }] : [];
    }
    if (sameBytes(locking, ownerLocking)) return ownerCoins;
    return [];
  },
  getHistory: async () => [{ txid: FUNDING_TXID, height: 1 }],
  getTransactionStatus: async () => {
    throw new Error('not used');
  },
  getTip: async () => {
    throw new Error('not used');
  },
  broadcast: async () => {
    throw new Error('not used');
  },
  subscribeAddress: async () => async () => undefined,
});

const OWNER_HEX = binToHex(OWNER_PKH);

describe('readOrderFromChain', () => {
  it('rebuilds the contract from the funding record and finds the unspent order UTXO', async () => {
    // #when
    const result = await readOrderFromChain(fakeChain(), FUNDING_TXID, OWNER_HEX);
    // #then
    expect(result.kind === 'ready' && result.onChain.orderUtxo).toMatchObject({
      txid: FUNDING_TXID,
      vout: 0,
    });
  });

  it('stops at a different wallet before building anything', async () => {
    const result = await readOrderFromChain(fakeChain(), FUNDING_TXID, '00'.repeat(20));
    expect(result.kind).toBe('not_owner');
  });

  it('reports an order whose output is already spent', async () => {
    const result = await readOrderFromChain(fakeChain({ orderUnspent: false }), FUNDING_TXID, OWNER_HEX);
    expect(result).toEqual({ kind: 'spent', spend: null });
  });
});

describe('buildOwnerCancel', () => {
  it('builds cancel() with the owner coin at input 0 and a refund that passes rule R', async () => {
    // #given
    const read = await readOrderFromChain(fakeChain(), FUNDING_TXID, OWNER_HEX);
    if (read.kind !== 'ready') throw new Error(read.kind);
    // #when
    const result = await buildOwnerCancel(fakeChain(), read.onChain);
    // #then
    expect(result.kind === 'built' && result.built.refundSats >= ORDER_VALUE - MAX_FEE).toBe(true);
  });

  it('asks for a coin at the owner address when it holds none (OwnerUtxoRequiredError)', async () => {
    const read = await readOrderFromChain(fakeChain(), FUNDING_TXID, OWNER_HEX);
    if (read.kind !== 'ready') throw new Error(read.kind);
    const result = await buildOwnerCancel(fakeChain({ ownerCoins: [] }), read.onChain);
    expect(result).toEqual({ kind: 'needs_coin', requiredSatoshis: 546n, largestSatoshis: 0n });
  });

  it('counts an owner address holding only token UTXOs as empty', async () => {
    const read = await readOrderFromChain(fakeChain(), FUNDING_TXID, OWNER_HEX);
    if (read.kind !== 'ready') throw new Error(read.kind);
    const tokenOnly: ChainUtxo = {
      txid: 'aa'.repeat(32),
      vout: 1,
      satoshis: 1_000n,
      height: 1,
      token: { category: CHIPNET_MARKET.tokenCategory, amount: 500n },
    };
    const result = await buildOwnerCancel(fakeChain({ ownerCoins: [tokenOnly] }), read.onChain);
    expect(result.kind).toBe('needs_coin');
  });

  it('builds cancelWithSig with the refund at output 0', async () => {
    const read = await readOrderFromChain(fakeChain(), FUNDING_TXID, OWNER_HEX);
    if (read.kind !== 'ready') throw new Error(read.kind);
    const built = buildSignatureCancel(read.onChain);
    expect(built.path === 'cancelWithSig' && built.refundSats >= ORDER_VALUE - MAX_FEE).toBe(true);
  });
});

describe('rule R and the server comparison', () => {
  const builtCancel = async () => {
    const read = await readOrderFromChain(fakeChain(), FUNDING_TXID, OWNER_HEX);
    if (read.kind !== 'ready') throw new Error(read.kind);
    const result = await buildOwnerCancel(fakeChain(), read.onChain);
    if (result.kind !== 'built') throw new Error(result.kind);
    return result.built;
  };

  const decoded = (hex: string) => {
    const transaction = decodeTransactionCommon(hexToBin(hex));
    if (typeof transaction === 'string') throw new Error(transaction);
    return transaction;
  };

  it('blocks a refund that pays anywhere but the owner address', async () => {
    // #given
    const built = await builtCancel();
    const transaction = decoded(built.draft.unsignedHex);
    const refund = transaction.outputs[1];
    if (refund === undefined) throw new Error('no refund');
    // #when
    const tampered = {
      ...transaction,
      outputs: [
        transaction.outputs[0],
        { ...refund, lockingBytecode: encodeLockingBytecodeP2pkh(new Uint8Array(20)) },
      ].filter((output) => output !== undefined),
    };
    // #then
    expect(checkCancelRules(tampered, built.ruleContext)).toBe('refund_address');
  });

  it('blocks a refund below the order value minus its fee cap', async () => {
    const built = await builtCancel();
    const transaction = decoded(built.draft.unsignedHex);
    const outputs = transaction.outputs.map((output, index) =>
      index === 1 ? { ...output, valueSatoshis: ORDER_VALUE - MAX_FEE - 1n } : output,
    );
    expect(checkCancelRules({ ...transaction, outputs }, built.ruleContext)).toBe('refund_value');
  });

  it('blocks an owner coin that does not come back whole', async () => {
    const built = await builtCancel();
    const transaction = decoded(built.draft.unsignedHex);
    const outputs = transaction.outputs.map((output, index) =>
      index === 0 ? { ...output, valueSatoshis: output.valueSatoshis - 1n } : output,
    );
    expect(checkCancelRules({ ...transaction, outputs }, built.ruleContext)).toBe('owner_output_value');
  });

  it('reads an identical server build as the same cancel', async () => {
    const built = await builtCancel();
    expect(compareWithServer(built.draft.unsignedHex, built.draft.unsignedHex, built.ruleContext)).toEqual({
      kind: 'same',
    });
  });

  it('reads a server build with another refund as different, without blocking anything', async () => {
    const built = await builtCancel();
    const transaction = decoded(built.draft.unsignedHex);
    const outputs = transaction.outputs.map((output, index) =>
      index === 1 ? { ...output, valueSatoshis: output.valueSatoshis - 10n } : output,
    );
    const serverHex = binToHex(encodeTransactionCommon({ ...transaction, outputs }));
    expect(compareWithServer(built.draft.unsignedHex, serverHex, built.ruleContext)).toEqual({
      kind: 'different',
      detail: 'its refund differs',
    });
  });
});
