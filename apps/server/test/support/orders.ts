import { readFileSync } from 'node:fs';
import {
  binToHex,
  encodeLockingBytecodeP2pkh,
  hash160,
  hexToBin,
  secp256k1,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, type Utxo } from 'cashscript';
import {
  buildExecuteTransaction,
  buildSignedCancelTransaction,
  encodeOrderRecord,
  instantiateOrder,
  orderFunding,
  orderLockingBytecode,
  poolLockingBytecode,
  type OrderParams,
} from '@atprice/core';
import { keeperExecuteFee } from '../../src/pools/quote.js';
import { livePoolFromUtxo, type LivePool } from '../../src/pools/reader.js';
import type { FakeChain } from './fake-chain.js';

export const TOKEN = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
export const provider = new MockNetworkProvider();

const key = (seed: number): { privateKey: Uint8Array; pkh: Uint8Array; signer: SignatureTemplate } => {
  const privateKey = new Uint8Array(32);
  privateKey[0] = 0x22;
  privateKey[31] = seed;
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  return { privateKey, pkh: hash160(publicKey), signer: new SignatureTemplate(privateKey) };
};

export const OWNER = key(1);
export const OTHER_OWNER = key(2);

let nonceSeed = 1;
const nextNonce = (): Uint8Array => {
  nonceSeed += 1;
  return Uint8Array.from([1, 2, 3, 4, 5, 6, 7, nonceSeed % 256]);
};

export const buyParams = (overrides: Partial<OrderParams> = {}): OrderParams => ({
  side: 'buy',
  ownerPkh: OWNER.pkh,
  recipientLockingBytecode: encodeLockingBytecodeP2pkh(OWNER.pkh),
  tokenCategory: TOKEN,
  minOut: 1n,
  maxNetworkFee: 2000n,
  nonce: nextNonce(),
  ...overrides,
});

export const sellParams = (overrides: Partial<OrderParams> = {}): OrderParams => ({
  ...buyParams(),
  side: 'sell',
  minOut: 2001n,
  ...overrides,
});

let inputSeed = 1;
const freshInput = () => {
  inputSeed += 1;
  const hash = new Uint8Array(32);
  new DataView(hash.buffer).setUint32(0, inputSeed);
  hash[31] = 0x99;
  return {
    outpointTransactionHash: hash,
    outpointIndex: 0,
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(),
  };
};

export interface FundingOptions {
  /** Extra satoshis on the order output (breaks the exact funding value). */
  readonly extraSatoshis?: bigint;
  /** A token on a buy order output (cancel-only). */
  readonly tokenOnBuy?: bigint;
}

/** A funding transaction shaped exactly as contract.md prescribes: [order, record, owner change]. */
export const fundingTransaction = (
  params: OrderParams,
  amount: bigint,
  options: FundingOptions = {},
): TransactionCommon => {
  const funding = orderFunding(params, amount, 0n);
  const orderOutput: Output = {
    lockingBytecode: orderLockingBytecode(params),
    valueSatoshis: funding.satoshis + (options.extraSatoshis ?? 0n),
    ...(params.side === 'sell'
      ? { token: { category: hexToBin(TOKEN), amount: funding.tokenAmount } }
      : options.tokenOnBuy !== undefined
        ? { token: { category: hexToBin(TOKEN), amount: options.tokenOnBuy } }
        : {}),
  };
  return {
    version: 2,
    locktime: 0,
    inputs: [freshInput()],
    outputs: [
      orderOutput,
      { lockingBytecode: encodeOrderRecord(params), valueSatoshis: 0n },
      { lockingBytecode: encodeLockingBytecodeP2pkh(params.ownerPkh), valueSatoshis: 10_000n },
    ],
  };
};

/** Any other payment to an address (a stray deposit, or a pool seed). */
export const paymentTransaction = (
  lockingBytecode: Uint8Array,
  satoshis: bigint,
  tokenAmount?: bigint,
): TransactionCommon => ({
  version: 2,
  locktime: 0,
  inputs: [freshInput()],
  outputs: [
    {
      lockingBytecode,
      valueSatoshis: satoshis,
      ...(tokenAmount !== undefined && { token: { category: hexToBin(TOKEN), amount: tokenAmount } }),
    },
  ],
});

export interface CapturedPool {
  readonly ownerPkh: string;
  readonly txid: string;
  readonly vout: number;
  readonly sats: string;
  readonly tokens: string;
  readonly height: number;
}

export const CAPTURED = JSON.parse(
  readFileSync(new URL('../fixtures/chipnet-pools.json', import.meta.url), 'utf8'),
) as { tokenCategory: string; capturedAt: string; tipHeight: number; pools: CapturedPool[] };

/** The captured chipnet pools with their real outpoints, as LivePools (for evaluator and maths tests). */
export const capturedLivePools = (): LivePool[] =>
  CAPTURED.pools.flatMap((pool) => {
    const live = livePoolFromUtxo(pool.ownerPkh, TOKEN, {
      txid: pool.txid,
      vout: pool.vout,
      satoshis: BigInt(pool.sats),
      height: pool.height,
      token: { category: TOKEN, amount: BigInt(pool.tokens) },
    });
    return live === undefined ? [] : [live];
  });

/** Seeds one captured pool's reserves into the fake chain at its real owner's pool address. */
export const seedPool = (
  chain: FakeChain,
  pool: CapturedPool,
  height = 342_200,
): { txid: string; outpoint: string } => {
  const txid = chain.add(
    paymentTransaction(poolLockingBytecode(hexToBin(pool.ownerPkh)), BigInt(pool.sats), BigInt(pool.tokens)),
    height,
  );
  return { txid, outpoint: `${txid}:0` };
};

export const orderUtxoOf = (fundingTxid: string, transaction: TransactionCommon): Utxo => {
  const output = transaction.outputs[0];
  if (output === undefined) throw new Error('no order output');
  return {
    txid: fundingTxid,
    vout: 0,
    satoshis: output.valueSatoshis,
    lockingBytecode: binToHex(output.lockingBytecode),
    ...(output.token && {
      token: { category: binToHex(output.token.category), amount: output.token.amount },
    }),
  };
};

/** A real execute of `params` against a seeded pool, built and VM-verified by core. */
export const executeHex = (
  params: OrderParams,
  fundingTxid: string,
  funding: TransactionCommon,
  pool: { txid: string; vout: number; ownerPkh: string; sats: bigint; tokens: bigint },
): string => {
  const built = buildExecuteTransaction(
    instantiateOrder(params, provider),
    orderUtxoOf(fundingTxid, funding),
    {
      txid: pool.txid,
      vout: pool.vout,
      satoshis: pool.sats,
      token: { category: TOKEN, amount: pool.tokens },
      ownerPkh: hexToBin(pool.ownerPkh),
      lockingBytecode: binToHex(poolLockingBytecode(hexToBin(pool.ownerPkh))),
    },
    { fee: { kind: 'absolute', satoshis: keeperExecuteFee(params.maxNetworkFee) } },
  );
  return built.hex;
};

/** A real owner-signed `cancel()`, authorized by the funding's owner change output. */
export const cancelHex = (params: OrderParams, fundingTxid: string, funding: TransactionCommon): string => {
  const change = funding.outputs[2];
  if (change === undefined) throw new Error('no owner change');
  const signed = buildSignedCancelTransaction({
    owner: {
      utxos: [
        {
          txid: fundingTxid,
          vout: 2,
          satoshis: change.valueSatoshis,
          lockingBytecode: binToHex(change.lockingBytecode),
        },
      ],
    },
    orders: [{ order: instantiateOrder(params, provider), utxo: orderUtxoOf(fundingTxid, funding) }],
    ownerSigner: OWNER.signer,
  });
  return signed.hex;
};
