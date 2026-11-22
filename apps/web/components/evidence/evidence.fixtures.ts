import {
  buildExecuteTransaction,
  encodeOrderRecord,
  instantiateOrder,
  orderLockingBytecode,
  type OrderParams,
} from '@atprice/core';
import { binToHex, encodeLockingBytecodeP2pkh, encodeTransactionBch, hashTransaction } from '@bitauth/libauth';
import { MockNetworkProvider } from 'cashscript';
import type { EvidenceOrder } from '@/lib/api/schemas';
import type { ChainAccess, TransactionStatus } from '@/lib/chain/types';

/*
 * Test-only builders. The transactions are real encodings built with core's own builders, so the
 * browser check is exercised against the same bytes a chain would return.
 */

/** The chipnet PUSDTEST category from core's allowlist (tests run as a chipnet build). */
export const CATEGORY = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
export const OWNER_PKH = new Uint8Array(20).fill(0x11);
export const POOL_PKH = new Uint8Array(20).fill(0x33);
const RECIPIENT = encodeLockingBytecodeP2pkh(new Uint8Array(20).fill(0x22));
const ORDER_SATS = 10_003_000n;

export const buyParams = (): OrderParams => ({
  side: 'buy',
  ownerPkh: OWNER_PKH,
  recipientLockingBytecode: RECIPIENT,
  tokenCategory: CATEGORY,
  minOut: 10n,
  maxNetworkFee: 2000n,
  nonce: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]),
});

export interface Chain {
  readonly fundingHex: string;
  readonly fundingTxid: string;
  readonly settlementHex: string;
  readonly settlementTxid: string;
  readonly delivered: bigint;
}

/** A funding transaction (order output 0, ATPR record output 1) and a real execute spending it. */
export const buildChain = (params: OrderParams = buyParams()): Chain => {
  const funding = encodeTransactionBch({
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointIndex: 0,
        outpointTransactionHash: new Uint8Array(32).fill(0x01),
        sequenceNumber: 0,
        unlockingBytecode: new Uint8Array(),
      },
    ],
    outputs: [
      { lockingBytecode: orderLockingBytecode(params), valueSatoshis: ORDER_SATS },
      { lockingBytecode: encodeOrderRecord(params), valueSatoshis: 0n },
    ],
  });
  const fundingTxid = hashTransaction(funding);
  const execute = buildExecuteTransaction(
    instantiateOrder(params, new MockNetworkProvider()),
    { txid: fundingTxid, vout: 0, satoshis: ORDER_SATS },
    {
      txid: binToHex(new Uint8Array(32).fill(0xaa)),
      vout: 0,
      satoshis: 150_545_039n,
      token: { category: CATEGORY, amount: 29_857n },
      ownerPkh: POOL_PKH,
    },
  );
  if (execute.execution.side !== 'buy') throw new Error('expected a buy execution');
  return {
    fundingHex: binToHex(funding),
    fundingTxid,
    settlementHex: execute.hex,
    settlementTxid: execute.txid,
    delivered: execute.execution.tokensOut,
  };
};

const TIME = '2026-11-22T13:58:00.000Z';

export const evidenceOrder = (overrides: Partial<EvidenceOrder> & { fundingTxid?: string } = {}): EvidenceOrder => {
  const fundingTxid = overrides.fundingTxid ?? binToHex(new Uint8Array(32).fill(0x3f));
  return {
    id: `${fundingTxid}:0`,
    funding: { txid: fundingTxid, vout: 0 },
    tokenCategory: CATEGORY,
    side: 'buy',
    amount: 5_000_000n,
    minOut: 2_250n,
    maxNetworkFee: 2000n,
    ownerPkh: binToHex(OWNER_PKH),
    recipientAddress: 'bchtest:qq3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs3ajz0a',
    contractVersion: 1,
    contractAddress: 'bchtest:pcontract',
    status: 'FILLED',
    supported: true,
    unsupportedReason: null,
    createdAt: TIME,
    updatedAt: TIME,
    events: [],
    keeperCheck: null,
    settlement: {
      kind: 'fill',
      txid: binToHex(new Uint8Array(32).fill(0xa1)),
      blockHeight: 925_110,
      confirmations: 10,
      received: 2_261n,
      surplus: 11n,
      poolOutpoint: { txid: binToHex(new Uint8Array(32).fill(0x9e)), vout: 0 },
      poolPkh: binToHex(POOL_PKH),
      poolFeeSats: 15_000n,
      networkFeeSats: 380n,
      filledBy: 'atprice_keeper',
    },
    fundingBlock: { height: 925_101, time: TIME },
    settlementBlock: { height: 925_110, time: TIME },
    ...overrides,
  };
};

export const fakeChain = (
  transactions: Readonly<Record<string, TransactionStatus>>,
  tipHeight: number,
  endpointLabel = 'electrum.test:50004',
): ChainAccess => {
  const unused = (): never => {
    throw new Error('not used by the evidence check');
  };
  return {
    endpointLabel,
    getTip: () => Promise.resolve({ height: tipHeight, hex: '', hash: '' }),
    getTransactionStatus: (txid: string) => {
      const status = transactions[txid];
      return status === undefined ? Promise.reject(new Error(`unknown ${txid}`)) : Promise.resolve(status);
    },
    getRawTransaction: unused,
    getUtxos: unused,
    getHistory: unused,
    broadcast: unused,
    subscribeAddress: unused,
  };
};
