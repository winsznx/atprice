import { SUPPORTED_MARKETS } from '@atprice/core';
import type { Order, TransactionEvent } from '@/lib/api/schemas';

/** Test data in the API's parsed shape, on the chipnet market the test build runs against. */

export const CHIPNET_MARKET = SUPPORTED_MARKETS.chipnet[0] ?? (() => {
  throw new Error('the chipnet allowlist is empty');
})();

export const FUNDING_TXID = '3f9a2b7c'.padEnd(58, '0') + 'e1c21d';
export const SETTLEMENT_TXID = 'b7e1'.padEnd(60, '1') + '90aa';
export const OWNER_PKH = 'ab'.repeat(20);

export const event = (overrides: Partial<TransactionEvent> = {}): TransactionEvent => ({
  txid: FUNDING_TXID,
  kind: 'funding',
  firstSeenAt: '2026-11-22T13:40:00.000Z',
  confirmations: 13,
  blockHeight: 925_101,
  blockHash: 'cd'.repeat(32),
  networkState: 'confirmed',
  conflict: null,
  ...overrides,
});

/** A buy of 230.00 PUSDTEST for 0.5 BCH: limit 460.00 PUSDTEST per BCH. */
export const makeOrder = (overrides: Partial<Order> = {}): Order => ({
  id: `${FUNDING_TXID}:0`,
  funding: { txid: FUNDING_TXID, vout: 0 },
  tokenCategory: CHIPNET_MARKET.tokenCategory,
  side: 'buy',
  amount: 50_000_000n,
  minOut: 23_000n,
  maxNetworkFee: 2_000n,
  ownerPkh: OWNER_PKH,
  recipientAddress: 'bchtest:qz2s4qcqh2kq5hcmqf6lq4r8qzpnmqfpqv5jv0ewt7',
  contractVersion: 1,
  contractAddress: 'bchtest:pwq4tlqs3ywdzm7qt4zyqxrtu6cd34ly9xt7lsvdrj2zg5ue4yhw5mjm9vq0w',
  status: 'OPEN',
  supported: true,
  unsupportedReason: null,
  createdAt: '2026-11-22T13:40:00.000Z',
  updatedAt: '2026-11-22T14:03:00.000Z',
  events: [event()],
  keeperCheck: {
    checkedAt: '2026-11-22T14:03:10.000Z',
    poolOutpoint: { txid: 'ee'.repeat(32), vout: 0 },
    bestOutput: 22_480n,
    outcome: 'LIMIT_NOT_MET',
  },
  settlement: null,
  ...overrides,
});

/** A sell of 1,250.00 PUSDTEST with minimum proceeds 0.052 BCH (minOut = P + 2,000 sat). */
export const makeSellOrder = (overrides: Partial<Order> = {}): Order =>
  makeOrder({ side: 'sell', amount: 125_000n, minOut: 5_202_000n, ...overrides });
