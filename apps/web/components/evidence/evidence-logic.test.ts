import { binToHex } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { ChainError } from '@/lib/chain/types';
import { fillRate } from '@/lib/orders/display';
import { buildChain, evidenceOrder, fakeChain, POOL_PKH } from './evidence.fixtures';
import {
  orderSearchState,
  orderTitle,
  spokenDateTime,
  verifyEvidenceOrder,
  verifyResultText,
} from './evidence-logic';

const TIP = 1_000;
const CONFIRMATIONS = 10;
const SETTLED_AT = TIP - CONFIRMATIONS + 1;

const scenario = (adjust: (order: ReturnType<typeof evidenceOrder>) => ReturnType<typeof evidenceOrder> = (o) => o) => {
  const chain = buildChain();
  const base = evidenceOrder({ fundingTxid: chain.fundingTxid, settlementBlock: { height: SETTLED_AT, time: '2026-11-22T13:58:00.000Z' } });
  const order = adjust({
    ...base,
    minOut: 10n,
    settlement: {
      kind: 'fill',
      txid: chain.settlementTxid,
      blockHeight: SETTLED_AT,
      confirmations: CONFIRMATIONS,
      received: chain.delivered,
      surplus: chain.delivered - 10n,
      poolOutpoint: { txid: binToHex(new Uint8Array(32).fill(0xaa)), vout: 0 },
      poolPkh: binToHex(POOL_PKH),
      poolFeeSats: 1_000n,
      networkFeeSats: 400n,
      filledBy: 'atprice_keeper',
    },
  });
  const access = fakeChain(
    {
      [chain.fundingTxid]: { hex: chain.fundingHex, confirmations: CONFIRMATIONS + 3, blockHash: 'a' },
      [chain.settlementTxid]: { hex: chain.settlementHex, confirmations: CONFIRMATIONS, blockHash: 'b' },
    },
    TIP,
  );
  return { order, access };
};

describe('verifyEvidenceOrder', () => {
  it('confirms a fill whose record, payout and pool owner all match the chain', async () => {
    const { order, access } = scenario();
    const result = await verifyEvidenceOrder(access, order);
    expect(result).toEqual({
      kind: 'confirmed',
      host: 'electrum.test:50004',
      settlement: 'fill',
      blockHeight: SETTLED_AT,
      confirmations: CONFIRMATIONS,
      payoutAndPoolMatch: true,
    });
    expect(verifyResultText(result)).toBe(
      'Verified in your browser via electrum.test:50004: fill confirmed in block 991, 10 confirmations, payout and pool owner match.',
    );
  });

  it('lists every difference instead of hiding it', async () => {
    const { order, access } = scenario((o) =>
      o.settlement.kind === 'fill'
        ? { ...o, minOut: 11n, settlement: { ...o.settlement, received: o.settlement.received + 1n, poolPkh: '44'.repeat(20) } }
        : o,
    );
    const result = await verifyEvidenceOrder(access, order);
    expect(result.kind).toBe('mismatch');
    if (result.kind !== 'mismatch') return;
    expect(result.differences).toEqual([
      "the record's minimum is 10 base units, the list says 11",
      expect.stringMatching(/^the payout is .* PUSDTEST, not .* PUSDTEST$/),
      'the pool owner key hash differs',
    ]);
    expect(verifyResultText(result)).toMatch(/^electrum\.test:50004 reports something different: /);
  });

  it('flags a settlement in a different block than listed', async () => {
    const { order, access } = scenario((o) => ({ ...o, settlementBlock: { ...o.settlementBlock, height: SETTLED_AT + 1 } }));
    const result = await verifyEvidenceOrder(access, order);
    expect(result).toMatchObject({ kind: 'mismatch', differences: ['the fill is in block 991, not 992'] });
  });

  it('calls a cancel listing over a fill a mismatch', async () => {
    const { order, access } = scenario((o) => ({
      ...o,
      status: 'CANCELLED',
      settlement: {
        kind: 'cancel',
        txid: o.settlement.txid,
        blockHeight: SETTLED_AT,
        confirmations: CONFIRMATIONS,
        refundSats: 1n,
        refundTokens: 0n,
        networkFeeSats: 1n,
        refundAddress: 'bchtest:x',
        authorizedBy: 'cancel',
      },
    }));
    const result = await verifyEvidenceOrder(access, order);
    expect(result).toMatchObject({ kind: 'mismatch', differences: ['the chain shows a fill, not a cancel'] });
  });

  it('reports an unreachable Electrum server by its DD 7.13 code', async () => {
    const { order } = scenario();
    const access = {
      ...fakeChain({}, TIP, 'down.example:50004'),
      getTip: () => Promise.reject(new ChainError('no_endpoint_reachable', 'every server failed')),
    };
    const result = await verifyEvidenceOrder(access, order);
    expect(result).toEqual({ kind: 'unreachable', host: 'down.example:50004', code: 'ELECTRUM_UNREACHABLE' });
    expect(verifyResultText(result)).toBe(
      "Couldn't reach down.example:50004 to verify. Try again or open the explorer link.",
    );
  });
});

describe('evidence card text', () => {
  it('derives the fill rate from proceeds, never from minOut', () => {
    const order = evidenceOrder({ side: 'buy', amount: 5_000_000n });
    const rate = fillRate(order, { received: 2_261n });
    // 22.61 PUSDTEST for 0.05 BCH is 452.2 per BCH.
    expect(rate).not.toBeNull();
    if (rate === null) return;
    expect(Number(rate.numerator) / Number(rate.denominator)).toBeCloseTo(452.2, 6);
    const sell = fillRate({ ...order, side: 'sell', amount: 2_261n }, { received: 5_002_000n });
    expect(sell === null ? null : Number(sell.numerator) / Number(sell.denominator)).toBeCloseTo(452.2, 6);
  });

  it('names the order and its time for screen readers', () => {
    expect(orderTitle(evidenceOrder())).toBe('Buy PUSDTEST on BCH / PUSDTEST');
    expect(spokenDateTime('2026-11-22T13:58:00.000Z', false)).toBe('22 November 2026, 13:58 UTC');
  });
});

describe('orderSearchState (?order=)', () => {
  const found = evidenceOrder({ fundingTxid: 'ab'.repeat(32) });
  const other = evidenceOrder();

  it('finds the order on any loaded page, case-insensitively', () => {
    expect(orderSearchState('AB'.repeat(32), [{ orders: [other] }, { orders: [found] }], true)).toEqual({
      kind: 'found',
      order: found,
    });
  });

  it('keeps loading up to five pages, then says it is not a completed order', () => {
    expect(orderSearchState('cd'.repeat(32), [{ orders: [other] }], true)).toEqual({ kind: 'searching' });
    const fivePages = Array.from({ length: 5 }, () => ({ orders: [other] }));
    expect(orderSearchState('cd'.repeat(32), fivePages, true)).toEqual({ kind: 'not_found', txid: 'cd'.repeat(32) });
    expect(orderSearchState('cd'.repeat(32), [{ orders: [other] }], false)).toEqual({ kind: 'not_found', txid: 'cd'.repeat(32) });
  });

  it('does nothing without the query', () => {
    expect(orderSearchState(null, [], true)).toEqual({ kind: 'none' });
  });
});
