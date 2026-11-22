import {
  encodeOrderRecord,
  orderLockingBytecode,
  SUPPORTED_MARKETS,
  type OrderParams,
} from '@atprice/core';
import {
  binToHex,
  encodeLockingBytecodeP2pkh,
  encodeTransactionBch,
  hash160,
  hashTransaction,
  hexToBin,
  secp256k1,
  type Output,
} from '@bitauth/libauth';
import { SignatureTemplate } from 'cashscript';
import type { FakeChain } from './chain';

export const CHIPNET_CATEGORY = SUPPORTED_MARKETS.chipnet[0]?.tokenCategory ?? '';

export const keyFixture = (seed: number) => {
  const privateKey = new Uint8Array(32);
  privateKey[0] = 0x11;
  privateKey[31] = seed;
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  const pkh = hash160(publicKey);
  return { privateKey, publicKey, pkh, lockingBytecode: encodeLockingBytecodeP2pkh(pkh), signer: new SignatureTemplate(privateKey) };
};

export const OWNER = keyFixture(1);
export const STRANGER = keyFixture(2);

export const buyParams = (overrides: Partial<OrderParams> = {}): OrderParams => ({
  side: 'buy',
  ownerPkh: OWNER.pkh,
  recipientLockingBytecode: OWNER.lockingBytecode,
  tokenCategory: CHIPNET_CATEGORY,
  minOut: 5_800n,
  maxNetworkFee: 2_000n,
  nonce: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]),
  ...overrides,
});

export const sellParams = (overrides: Partial<OrderParams> = {}): OrderParams =>
  buyParams({ side: 'sell', minOut: 146_934n, ...overrides });

const SOURCE_TXID = 'ab'.repeat(32);

/** A funding transaction as `buildFundingTransaction` shapes it: order, record, owner change. */
export const fundingTransaction = (
  params: OrderParams,
  options: { orderOutput?: Output; extraOutputs?: Output[]; recordBytecode?: Uint8Array } = {},
): { hex: string; txid: string } => {
  const orderOutput: Output =
    options.orderOutput ??
    (params.side === 'buy'
      ? { lockingBytecode: orderLockingBytecode(params), valueSatoshis: 153_000n }
      : {
          lockingBytecode: orderLockingBytecode(params),
          valueSatoshis: 2_000n,
          token: { category: hexToBin(params.tokenCategory), amount: 30n },
        });
  const transaction = {
    version: 2,
    locktime: 0,
    inputs: [{ outpointTransactionHash: hexToBin(SOURCE_TXID), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
    outputs: [
      orderOutput,
      { lockingBytecode: options.recordBytecode ?? encodeOrderRecord(params), valueSatoshis: 0n },
      { lockingBytecode: encodeLockingBytecodeP2pkh(params.ownerPkh), valueSatoshis: 1_000n },
      ...(options.extraOutputs ?? []),
    ],
  };
  const encoded = encodeTransactionBch(transaction);
  return { hex: binToHex(encoded), txid: hashTransaction(encoded) };
};

/** Puts an unspent funded order on the fake server and returns its funding txid. */
export const seedUnspentOrder = (chain: FakeChain, params: OrderParams, fundingHeight = 342_300): string => {
  const funding = fundingTransaction(params);
  chain.addTransaction(funding.txid, funding.hex);
  const locking = orderLockingBytecode(params);
  const tokenAmount = params.side === 'sell' ? 30n : undefined;
  chain.setUtxos(locking, [
    {
      txid: funding.txid,
      vout: 0,
      satoshis: params.side === 'buy' ? 153_000n : 2_000n,
      height: fundingHeight,
      ...(tokenAmount !== undefined && { token: { category: params.tokenCategory, amount: tokenAmount } }),
    },
  ]);
  chain.setHistory(locking, [{ txid: funding.txid, height: fundingHeight }]);
  chain.setHistory(encodeLockingBytecodeP2pkh(params.ownerPkh), [{ txid: funding.txid, height: fundingHeight }]);
  return funding.txid;
};
