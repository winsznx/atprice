import {
  binToHex,
  encodeLockingBytecodeP2sh32,
  encodeTransactionBch,
  hexToBin,
  type TransactionCommon,
} from '@bitauth/libauth';
import type { Utxo } from 'cashscript';
import { describe, expect, it } from 'vitest';
import {
  AtPriceError,
  buildCancelTransaction,
  buildCancelWithSigTransaction,
  buildExecuteTransaction,
  decodeOrderRecord,
  decodeTransactionHex,
  encodeOrderRecord,
  finalizeWalletSignedTransaction,
  InsufficientFundsError,
  instantiateOrder,
  InvalidOrderParamsError,
  InvalidPoolError,
  orderAddresses,
  OrderNotExecutableError,
  poolLockingBytecode,
  TransactionBuildError,
  TransactionVerificationError,
  verifyTransaction,
  type CauldronPoolUtxo,
  type OrderParams,
} from '../src/index.js';
import {
  buyParams,
  CATEGORY,
  fakeTxid,
  OTHER_CATEGORY,
  OWNER,
  POOL_OWNER,
  sellParams,
  STRANGER,
} from './support/fixtures.js';
import { CHANGE_KEY, fund, KEYS, provider, RECEIVE_5_KEY, walletUtxo } from './support/funding.js';
import { signAsWallet } from './support/wallet.js';

const toHex = (transaction: TransactionCommon): string => binToHex(encodeTransactionBch(transaction));

describe('buildFundingTransaction', () => {
  it('builds [order, record, owner change] for a buy, signable by a WizardConnect wallet', () => {
    const params = buyParams();
    const utxos = [
      walletUtxo(OWNER, 'receive', 0, 50_000n),
      walletUtxo(CHANGE_KEY, 'change', 3, 2_000_000n),
      walletUtxo(RECEIVE_5_KEY, 'receive', 5, 30_000n),
    ];
    const draft = fund(params, 100_000n, utxos);
    const tx = decodeTransactionHex(draft.unsignedHex);
    expect(tx.outputs).toHaveLength(3);
    expect(tx.outputs[0]).toEqual({
      lockingBytecode: orderAddresses(params, 'chipnet').lockingBytecode,
      valueSatoshis: 103_000n,
    });
    expect(tx.outputs[1]?.lockingBytecode).toEqual(encodeOrderRecord(params));
    expect(decodeOrderRecord(tx.outputs[1]?.lockingBytecode ?? new Uint8Array())).toEqual({
      version: 1,
      ...params,
    });
    expect(tx.outputs[2]?.lockingBytecode).toEqual(OWNER.lockingBytecode);
    expect(draft.request.inputPaths).toEqual([[0, 'change', 3]]);
    expect(draft.orderAddress).toBe(orderAddresses(params, 'chipnet').address);
    expect(draft.fee).toBe(BigInt(draft.estimatedSize));
    expect(draft.ownerOutputSatoshis).toBe(2_000_000n - 103_000n - draft.fee);

    const signed = finalizeWalletSignedTransaction(draft, signAsWallet(draft.request, KEYS));
    expect(signed.size).toBe(draft.estimatedSize);
    expect(signed.fee).toBe(draft.fee);
  });

  it('adds inputs until output 2 holds at least the 1000-sat marker', () => {
    const params = buyParams();
    const value = 100_000n + 3000n;
    const draft = fund(params, 100_000n, [
      walletUtxo(OWNER, 'receive', 0, value + 500n),
      walletUtxo(RECEIVE_5_KEY, 'receive', 5, 1200n),
    ]);
    expect(draft.request.inputPaths).toEqual([
      [0, 'receive', 0],
      [1, 'receive', 5],
    ]);
    expect(draft.ownerOutputSatoshis).toBe(value + 1700n - value - draft.fee);
    expect(draft.ownerOutputSatoshis >= 1000n).toBe(true);
    finalizeWalletSignedTransaction(draft, signAsWallet(draft.request, KEYS));
  });

  it('funds a sell with plain fungible UTXOs of the market token and returns token change on output 3', () => {
    const params = sellParams();
    const utxos = [
      walletUtxo(OWNER, 'receive', 0, 800n, { category: CATEGORY, amount: 300n }),
      walletUtxo(OWNER, 'receive', 0, 800n, { category: CATEGORY, amount: 900n }),
      walletUtxo(OWNER, 'receive', 0, 800n, {
        category: CATEGORY,
        amount: 5000n,
        nft: { capability: 'none', commitment: '01' },
      }),
      walletUtxo(OWNER, 'receive', 0, 800n, { category: OTHER_CATEGORY, amount: 5000n }),
      walletUtxo(CHANGE_KEY, 'change', 3, 20_000n),
    ];
    const draft = fund(params, 1000n, utxos);
    const tx = decodeTransactionHex(draft.unsignedHex);
    expect(tx.inputs.map((input) => binToHex(input.outpointTransactionHash))).toEqual([
      utxos[1]?.txid,
      utxos[0]?.txid,
      utxos[4]?.txid,
    ]);
    expect(tx.outputs[0]?.valueSatoshis).toBe(2000n);
    expect(tx.outputs[0]?.token?.amount).toBe(1000n);
    expect(tx.outputs[2]?.token).toBeUndefined();
    expect(tx.outputs[3]?.lockingBytecode).toEqual(OWNER.lockingBytecode);
    expect(tx.outputs[3]?.token?.amount).toBe(200n);
    expect(draft.ownerTokenChange).toBe(200n);
    expect(draft.orderAddress).toBe(orderAddresses(params, 'chipnet').tokenAddress);
    finalizeWalletSignedTransaction(draft, signAsWallet(draft.request, KEYS));
  });

  it('reports what is missing', () => {
    expect(() => fund(buyParams(), 100_000n, [walletUtxo(OWNER, 'receive', 0, 100_000n)])).toThrow(
      InsufficientFundsError,
    );
    expect(() =>
      fund(sellParams(), 1000n, [
        walletUtxo(OWNER, 'receive', 0, 50_000n, { category: CATEGORY, amount: 999n }),
      ]),
    ).toThrow(InsufficientFundsError);
    const p2sh = {
      ...walletUtxo(OWNER, 'receive', 0, 1_000_000n),
      lockingBytecode: binToHex(encodeLockingBytecodeP2sh32(new Uint8Array(32))),
    };
    expect(() => fund(buyParams(), 100_000n, [p2sh])).toThrow(TransactionBuildError);
  });

  it('refuses out-of-domain params before looking at the wallet', () => {
    const plenty = [walletUtxo(OWNER, 'receive', 0, 10_000_000n)];
    const reasonOf = (params: OrderParams): string | undefined => {
      try {
        fund(params, 100_000n, plenty);
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidOrderParamsError);
        return (error as InvalidOrderParamsError).reason;
      }
    };
    expect(reasonOf(buyParams({ nonce: new Uint8Array(8) }))).toBe('nonce_zero');
    expect(reasonOf(buyParams({ maxNetworkFee: 5001n }))).toBe('max_network_fee_range');
    expect(reasonOf(sellParams({ minOut: 2000n }))).toBe('min_out_range');
    expect(reasonOf(buyParams({ recipientLockingBytecode: hexToBin('51') }))).toBe('recipient_template');
    expect(() => fund(buyParams({ nonce: new Uint8Array(8) }), 100_000n, [])).toThrow(
      InvalidOrderParamsError,
    );
  });
});

/** Funds two orders and returns their order UTXOs plus the owner change of the second funding. */
const fundedOrders = () => {
  const buy = buyParams();
  const sell = sellParams({ nonce: Uint8Array.from([7, 7, 7, 7, 7, 7, 7, 7]) });
  const buyDraft = fund(buy, 100_000n, [walletUtxo(OWNER, 'receive', 0, 500_000n)]);
  const buySigned = finalizeWalletSignedTransaction(buyDraft, signAsWallet(buyDraft.request, KEYS));
  const sellDraft = fund(sell, 1000n, [
    walletUtxo(OWNER, 'receive', 0, 800n, { category: CATEGORY, amount: 1000n }),
    walletUtxo(OWNER, 'receive', 0, 10_000n),
  ]);
  const sellSigned = finalizeWalletSignedTransaction(sellDraft, signAsWallet(sellDraft.request, KEYS));
  const outputOf = (hex: string, txid: string, vout: number): Utxo => {
    const output = decodeTransactionHex(hex).outputs[vout];
    if (output === undefined) throw new Error('missing output');
    return {
      txid,
      vout,
      satoshis: output.valueSatoshis,
      ...(output.token && {
        token: { category: binToHex(output.token.category), amount: output.token.amount },
      }),
    };
  };
  return {
    orders: [
      { order: instantiateOrder(buy, provider), utxo: outputOf(buySigned.hex, buySigned.txid, 0) },
      { order: instantiateOrder(sell, provider), utxo: outputOf(sellSigned.hex, sellSigned.txid, 0) },
    ],
    ownerChange: outputOf(sellSigned.hex, sellSigned.txid, 2),
  };
};

describe('buildCancelTransaction (cancel())', () => {
  it('cancels two funded orders using the funding change as the owner authorization', () => {
    const { orders, ownerChange } = fundedOrders();
    const draft = buildCancelTransaction({ owner: { utxos: [ownerChange] }, orders });
    expect(draft.request.inputPaths).toEqual([[0, 'receive', 0]]);
    expect(draft.request.transaction.sourceOutputs.map((output) => output.contract)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(draft.request.transaction.broadcast).toBe(false);
    expect(JSON.parse(JSON.stringify(draft.request))).toEqual(draft.request);
    const signed = finalizeWalletSignedTransaction(draft, signAsWallet(draft.request, KEYS));
    const tx = decodeTransactionHex(signed.hex);
    expect(tx.outputs[0]?.valueSatoshis).toBe(ownerChange.satoshis);
    expect(tx.outputs[1]?.lockingBytecode).toEqual(OWNER.lockingBytecode);
    expect(tx.outputs[2]?.token?.amount).toBe(1000n);
    expect(signed.size).toBe(draft.estimatedSize);
  });

  it('restores a covenant input a wallet rewrote, and refuses changed outputs', () => {
    const { orders, ownerChange } = fundedOrders();
    const draft = buildCancelTransaction({ owner: { utxos: [ownerChange] }, orders });
    const signedHex = signAsWallet(draft.request, KEYS);
    const tx = decodeTransactionHex(signedHex);
    const rewritten = {
      ...tx,
      inputs: tx.inputs.map((input, index) =>
        index === 1 ? { ...input, unlockingBytecode: Uint8Array.of(0x51) } : input,
      ),
    };
    expect(() => finalizeWalletSignedTransaction(draft, toHex(rewritten))).not.toThrow();
    const output = tx.outputs[0];
    if (output === undefined) throw new Error('missing output');
    const stolen = {
      ...tx,
      outputs: [{ ...output, lockingBytecode: STRANGER.lockingBytecode }, ...tx.outputs.slice(1)],
    };
    expect(() => finalizeWalletSignedTransaction(draft, toHex(stolen))).toThrow(TransactionVerificationError);
  });

  it('refuses orders of different owners and an owner UTXO that is not the owner P2PKH', () => {
    const { orders, ownerChange } = fundedOrders();
    const foreign = {
      order: instantiateOrder(buyParams({ ownerPkh: STRANGER.pkh }), provider),
      utxo: orders[0]?.utxo ?? ownerChange,
    };
    expect(() =>
      buildCancelTransaction({ owner: { utxos: [ownerChange] }, orders: [...orders, foreign] }),
    ).toThrow(TransactionBuildError);
    expect(() =>
      buildCancelTransaction({
        owner: { utxos: [{ ...ownerChange, lockingBytecode: binToHex(STRANGER.lockingBytecode) }] },
        orders,
      }),
    ).toThrow(TransactionBuildError);
    expect(() => buildCancelTransaction({ owner: { utxos: [ownerChange] }, orders: [] })).toThrow(
      TransactionBuildError,
    );
  });
});

describe('buildCancelWithSigTransaction (cancelWithSig())', () => {
  it('produces placeholders, contract info and inputPaths that a placeholder-filling wallet signs', () => {
    const { orders } = fundedOrders();
    const draft = buildCancelWithSigTransaction({ orders });
    expect(draft.request.inputPaths).toEqual([
      [0, 'receive', 0],
      [1, 'receive', 0],
    ]);
    draft.request.transaction.sourceOutputs.forEach((output, index) => {
      expect(output.contract?.abiFunction.name).toBe('cancelWithSig');
      expect(output.contract?.artifact.contractName).toBe(index === 0 ? 'AtPriceBuy' : 'AtPriceSell');
      expect(output.contract?.redeemScript).toBe(orders[index]?.order.contract.bytecode);
      expect(output.unlockingBytecode).toContain(`41${'00'.repeat(65)}`);
      expect(output.unlockingBytecode).toContain(`21${'00'.repeat(33)}`);
    });
    const signed = finalizeWalletSignedTransaction(draft, signAsWallet(draft.request, KEYS));
    expect(signed.size).toBe(draft.estimatedSize);
    expect(decodeTransactionHex(signed.hex).outputs).toHaveLength(2);
  });
});

describe('buildExecuteTransaction', () => {
  const pool = (overrides: Partial<CauldronPoolUtxo> = {}): CauldronPoolUtxo => ({
    txid: fakeTxid(0xaa),
    vout: 0,
    satoshis: 150_545_039n,
    token: { category: CATEGORY, amount: 29_857n },
    ownerPkh: POOL_OWNER.pkh,
    ...overrides,
  });
  const orderUtxo = (satoshis: bigint, token?: Utxo['token']): Utxo => ({
    txid: fakeTxid(0xbb),
    vout: 0,
    satoshis,
    ...(token && { token }),
  });

  it('pays the miner exactly size * 1 sat/B by default and gives the rest of the allowance to the user', () => {
    const order = instantiateOrder(buyParams(), provider);
    const tx = buildExecuteTransaction(order, orderUtxo(10_003_000n), pool());
    expect(tx.fee >= BigInt(tx.size) && tx.fee <= BigInt(tx.size) + 2n).toBe(true);
    expect(tx.execution.side === 'buy' && tx.execution.bchIn).toBe(10_003_000n - 1000n - tx.fee);
    expect(verifyTransaction(tx.hex, tx.sourceOutputs).txid).toBe(tx.txid);
  });

  it('honours a higher fee rate and refuses one the allowance cannot cover', () => {
    const order = instantiateOrder(buyParams(), provider);
    const doubled = buildExecuteTransaction(order, orderUtxo(10_003_000n), pool(), {
      fee: { kind: 'rate', satsPerByte: 2n },
    });
    expect(doubled.fee >= 2n * BigInt(doubled.size)).toBe(true);
    const reasonOf = (action: () => unknown): string | undefined => {
      try {
        action();
      } catch (error) {
        return error instanceof AtPriceError ? error.reason : 'unexpected';
      }
      return undefined;
    };
    expect(
      reasonOf(() =>
        buildExecuteTransaction(order, orderUtxo(10_003_000n), pool(), {
          fee: { kind: 'rate', satsPerByte: 3n },
        }),
      ),
    ).toBe('fee_above_cap');
    expect(
      reasonOf(() =>
        buildExecuteTransaction(order, orderUtxo(10_003_000n), pool(), {
          fee: { kind: 'absolute', satoshis: 2001n },
        }),
      ),
    ).toBe('fee_above_cap');
    expect(() =>
      buildExecuteTransaction(order, orderUtxo(10_003_000n), pool(), {
        fee: { kind: 'absolute', satoshis: 100n },
      }),
    ).toThrow(Error);
  });

  it('refuses a fill below minOut, a foreign pool and a mismatched order UTXO', () => {
    const order = instantiateOrder(buyParams({ minOut: 1855n }), provider);
    expect(() => buildExecuteTransaction(order, orderUtxo(10_003_000n), pool())).toThrow(
      OrderNotExecutableError,
    );
    const plain = instantiateOrder(buyParams(), provider);
    expect(() =>
      buildExecuteTransaction(
        plain,
        orderUtxo(10_003_000n),
        pool({ token: { category: OTHER_CATEGORY, amount: 1n } }),
      ),
    ).toThrow(InvalidPoolError);
    const wrongLocking = binToHex(poolLockingBytecode(STRANGER.pkh));
    expect(() =>
      buildExecuteTransaction(plain, orderUtxo(10_003_000n), pool({ lockingBytecode: wrongLocking })),
    ).toThrow(InvalidPoolError);
    expect(() =>
      buildExecuteTransaction(plain, orderUtxo(10_003_000n, { category: CATEGORY, amount: 1n }), pool()),
    ).toThrow(OrderNotExecutableError);
    const sell = instantiateOrder(sellParams(), provider);
    expect(() =>
      buildExecuteTransaction(sell, orderUtxo(2000n, { category: OTHER_CATEGORY, amount: 5n }), pool()),
    ).toThrow(OrderNotExecutableError);
    expect(() => buildExecuteTransaction(plain, orderUtxo(2500n), pool())).toThrow(OrderNotExecutableError);
    expect(hexToBin(wrongLocking).length).toBe(35);
  });
});

describe('verifyTransaction', () => {
  const signedExecute = () => {
    const order = instantiateOrder(buyParams(), provider);
    return buildExecuteTransaction(
      order,
      { txid: fakeTxid(0xcc), vout: 0, satoshis: 10_003_000n },
      {
        txid: fakeTxid(0xdd),
        vout: 0,
        satoshis: 150_545_039n,
        token: { category: CATEGORY, amount: 29_857n },
        ownerPkh: POOL_OWNER.pkh,
      },
    );
  };
  const reasonOf = (action: () => unknown): string | undefined => {
    try {
      action();
    } catch (error) {
      return error instanceof TransactionVerificationError ? error.reason : 'unexpected';
    }
    return undefined;
  };

  it('rejects undecodable hex, a source output count mismatch, a VM failure and a fee below 1 sat/B', () => {
    const tx = signedExecute();
    expect(reasonOf(() => verifyTransaction('00', tx.sourceOutputs))).toBe('decode_failed');
    expect(reasonOf(() => verifyTransaction(tx.hex, tx.sourceOutputs.slice(1)))).toBe('source_output_count');
    const [pool, order] = tx.sourceOutputs;
    if (pool === undefined || order === undefined) throw new Error('missing source outputs');
    expect(
      reasonOf(() =>
        verifyTransaction(tx.hex, [pool, { ...order, lockingBytecode: STRANGER.lockingBytecode }]),
      ),
    ).toBe('vm_rejected');
    expect(reasonOf(() => verifyTransaction(tx.hex, tx.sourceOutputs, 2n))).toBe('fee_below_relay_minimum');
    expect(reasonOf(() => verifyTransaction(tx.hex, tx.sourceOutputs))).toBeUndefined();
  });
});
