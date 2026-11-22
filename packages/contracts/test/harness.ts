import {
  binToHex,
  createVirtualMachineBch2026,
  decodeTransactionBch,
  encodeLockingBytecodeP2pkh,
  encodeLockingBytecodeP2sh32,
  encodeTransactionBch,
  hash160,
  hexToBin,
  secp256k1,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { buildPoolV0UnlockingBytecode, ExchangeLab } from '@cashlab/cauldron';
import { MockNetworkProvider, SignatureTemplate, type Utxo } from 'cashscript';
import { expect } from 'vitest';
import {
  instantiateOrder,
  poolLockingBytecode,
  poolUnlockingBytecode,
  type CauldronPoolUtxo,
  type Order,
  type OrderParams,
  type PoolReserves,
} from '@atprice/core';

/** Non-palindromic categories (display order), so a byte-order mistake cannot pass by accident. */
export const CATEGORY = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fa0';
export const OTHER_CATEGORY = 'f0e0d0c0b0a090807060504030201000ffeeddccbbaa99887766554433221101';

export interface Key {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly pkh: Uint8Array;
  readonly lockingBytecode: Uint8Array;
  readonly signer: SignatureTemplate;
}

export const key = (seed: number): Key => {
  const privateKey = new Uint8Array(32).fill(seed);
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  const pkh = hash160(publicKey);
  return {
    privateKey,
    publicKey,
    pkh,
    lockingBytecode: encodeLockingBytecodeP2pkh(pkh),
    signer: new SignatureTemplate(privateKey),
  };
};

export const OWNER = key(0x21);
export const STRANGER = key(0x22);
export const POOL_OWNER = key(0x23);
export const OTHER_POOL_OWNER = key(0x24);
export const P2SH32_RECIPIENT = encodeLockingBytecodeP2sh32(new Uint8Array(32).fill(0x5a));

export const orderParams = (
  side: OrderParams['side'],
  overrides: Partial<OrderParams> = {},
): OrderParams => ({
  side,
  ownerPkh: OWNER.pkh,
  recipientLockingBytecode: OWNER.lockingBytecode,
  tokenCategory: CATEGORY,
  minOut: side === 'buy' ? 1n : 2001n,
  maxNetworkFee: 2000n,
  nonce: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
  ...overrides,
});

const exchangeLab = new ExchangeLab();
const standardVm = createVirtualMachineBch2026(true);
let txidCounter = 0;
const nextTxid = (): string => {
  txidCounter += 1;
  return binToHex(Uint8Array.from({ length: 32 }, (_, index) => (txidCounter * 31 + index * 7) & 0xff));
};

export const sourceOutputOf = (utxo: Utxo & { lockingBytecode: string }): Output => ({
  lockingBytecode: hexToBin(utxo.lockingBytecode),
  valueSatoshis: utxo.satoshis,
  ...(utxo.token && {
    token: {
      category: hexToBin(utxo.token.category),
      amount: utxo.token.amount,
      ...(utxo.token.nft && {
        nft: { capability: utxo.token.nft.capability, commitment: hexToBin(utxo.token.nft.commitment) },
      }),
    },
  }),
});

/** A mock chain (CashScript MockNetworkProvider, which runs every broadcast through the BCH_2026_05 VM). */
export class Chain {
  readonly provider = new MockNetworkProvider();

  /** A Cauldron V0 pool UTXO whose locking bytecode comes from the @cashlab/cauldron template. */
  addPool(reserves: PoolReserves, options: { category?: string; owner?: Key } = {}): CauldronPoolUtxo {
    const ownerPkh = (options.owner ?? POOL_OWNER).pkh;
    const templateLocking = exchangeLab.generatePoolV0LockingBytecode({ withdraw_pubkey_hash: ownerPkh });
    expect(templateLocking).toEqual(poolLockingBytecode(ownerPkh));
    expect(buildPoolV0UnlockingBytecode({ withdraw_pubkey_hash: ownerPkh })).toEqual(
      poolUnlockingBytecode(ownerPkh),
    );
    const utxo = this.provider.addUtxo(binToHex(templateLocking), {
      txid: nextTxid(),
      vout: 0,
      satoshis: reserves.sats,
      token: { category: options.category ?? CATEGORY, amount: reserves.tokens },
    });
    return { ...utxo, token: { category: options.category ?? CATEGORY, amount: reserves.tokens }, ownerPkh };
  }

  addOrder(
    params: OrderParams,
    funding: { satoshis: bigint; token?: Utxo['token'] },
  ): { order: Order; utxo: Utxo & { lockingBytecode: string } } {
    const order = instantiateOrder(params, this.provider);
    const utxo = this.provider.addUtxo(order.contract.lockingBytecode, {
      txid: nextTxid(),
      vout: 1,
      satoshis: funding.satoshis,
      ...(funding.token && { token: funding.token }),
    });
    return { order, utxo: { ...utxo, lockingBytecode: order.contract.lockingBytecode } };
  }

  /** A UTXO at an existing order address (for example a stray deposit). */
  addUtxoAt(
    order: Order,
    funding: { satoshis: bigint; token?: Utxo['token'] },
  ): Utxo & { lockingBytecode: string } {
    const utxo = this.provider.addUtxo(order.contract.lockingBytecode, {
      txid: nextTxid(),
      vout: 2,
      satoshis: funding.satoshis,
      ...(funding.token && { token: funding.token }),
    });
    return { ...utxo, lockingBytecode: order.contract.lockingBytecode };
  }

  addP2pkh(owner: Key, satoshis: bigint, token?: Utxo['token']): Utxo & { lockingBytecode: string } {
    const lockingBytecode = binToHex(owner.lockingBytecode);
    const utxo = this.provider.addUtxo(lockingBytecode, {
      txid: nextTxid(),
      vout: 0,
      satoshis,
      ...(token && { token }),
    });
    return { ...utxo, lockingBytecode };
  }

  /**
   * Asserts the transaction passes the libauth BCH_2026_05 VM in standard mode, pays at least
   * 1 sat/B, and is accepted by the mock network (a second, independent VM evaluation).
   */
  async expectAccepted(
    hex: string,
    sourceOutputs: readonly Output[],
  ): Promise<{ size: number; fee: bigint }> {
    const transaction = decode(hex);
    expect(standardVm.verify({ transaction, sourceOutputs: [...sourceOutputs] })).toBe(true);
    const size = hexToBin(hex).length;
    const fee =
      sourceOutputs.reduce((total, output) => total + output.valueSatoshis, 0n) -
      transaction.outputs.reduce((total, output) => total + output.valueSatoshis, 0n);
    expect(fee >= BigInt(size)).toBe(true);
    await this.provider.sendRawTransaction(hex);
    return { size, fee };
  }
}

export const decode = (hex: string): TransactionCommon => {
  const transaction = decodeTransactionBch(hexToBin(hex));
  if (typeof transaction === 'string') throw new Error(transaction);
  return transaction;
};

/** Prefix of libauth's token-consensus failures, raised before any input script is evaluated. */
export const TOKEN_CONSENSUS_ERROR = /^Transaction violates token validation/;

/** Asserts the standard VM rejects the transaction, optionally at a given input. */
export const expectRejected = (
  transaction: TransactionCommon,
  sourceOutputs: readonly Output[],
  inputIndex?: number,
): string => {
  const result = standardVm.verify({ transaction, sourceOutputs: [...sourceOutputs] });
  expect(result).not.toBe(true);
  if (inputIndex !== undefined) expect(String(result)).toContain(`evaluating input index ${inputIndex}`);
  return String(result);
};

export interface RawInput {
  readonly utxo: Utxo & { lockingBytecode: string };
  /** Either fixed unlocking bytecode or a function of the final transaction (for contract unlockers). */
  readonly unlock:
    | Uint8Array
    | ((transaction: TransactionCommon, sourceOutputs: Output[], inputIndex: number) => Uint8Array);
}

/** Assembles an arbitrary transaction, for rejection tests that the builders would refuse to produce. */
export const rawTransaction = (
  inputs: readonly RawInput[],
  outputs: readonly Output[],
  version = 2,
): { transaction: TransactionCommon; sourceOutputs: Output[]; hex: string } => {
  const sourceOutputs = inputs.map(({ utxo }) => sourceOutputOf(utxo));
  const transaction: TransactionCommon = {
    version,
    locktime: 0,
    inputs: inputs.map(({ utxo }) => ({
      outpointTransactionHash: hexToBin(utxo.txid),
      outpointIndex: utxo.vout,
      sequenceNumber: 0xfffffffe,
      unlockingBytecode: new Uint8Array(),
    })),
    outputs: [...outputs],
  };
  inputs.forEach(({ unlock }, index) => {
    const input = transaction.inputs[index];
    if (input === undefined) throw new Error('missing input');
    input.unlockingBytecode =
      typeof unlock === 'function' ? unlock(transaction, sourceOutputs, index) : unlock;
  });
  return { transaction, sourceOutputs, hex: binToHex(encodeTransactionBch(transaction)) };
};

export const contractUnlock =
  (unlocker: {
    generateUnlockingBytecode: (options: {
      transaction: TransactionCommon;
      sourceOutputs: Output[];
      inputIndex: number;
    }) => Uint8Array;
  }) =>
  (transaction: TransactionCommon, sourceOutputs: Output[], inputIndex: number): Uint8Array =>
    unlocker.generateUnlockingBytecode({ transaction, sourceOutputs, inputIndex });

export const poolOutput = (
  pool: CauldronPoolUtxo,
  after: PoolReserves,
  category = pool.token.category,
): Output => ({
  lockingBytecode: poolLockingBytecode(pool.ownerPkh),
  valueSatoshis: after.sats,
  token: { category: hexToBin(category), amount: after.tokens },
});

export const tokenOutput = (
  lockingBytecode: Uint8Array,
  valueSatoshis: bigint,
  category: string,
  amount: bigint,
): Output => ({
  lockingBytecode,
  valueSatoshis,
  token: { category: hexToBin(category), amount },
});
