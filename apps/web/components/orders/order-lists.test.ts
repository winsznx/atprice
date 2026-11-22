import { describe, expect, it } from 'vitest';
import {
  defaultTab,
  distanceLine,
  distanceToLimit,
  minimumLine,
  normalizeTxid,
  orderRowName,
  outcomeLine,
  parseTab,
  refreshIntervalFor,
  settlementTxid,
  splitOrders,
} from './order-lists';
import { event, FUNDING_TXID, makeOrder, makeSellOrder, SETTLEMENT_TXID } from './test-fixtures';

describe('orders.md tab membership', () => {
  it('splits by status and pins RECONCILIATION_REQUIRED to the top of Pending', () => {
    const orders = [
      makeOrder({ id: 'open', status: 'OPEN' }),
      makeOrder({ id: 'funding', status: 'FUNDING_PENDING', createdAt: '2026-11-22T15:00:00.000Z' }),
      makeOrder({ id: 'review', status: 'RECONCILIATION_REQUIRED', createdAt: '2026-11-20T10:00:00.000Z' }),
      makeOrder({ id: 'cancelling', status: 'CANCELLATION_PENDING' }),
      makeOrder({ id: 'filled', status: 'FILLED' }),
      makeOrder({ id: 'cancelled', status: 'CANCELLED' }),
    ];
    const split = splitOrders(orders);
    expect(split.open.map((order) => order.id)).toEqual(['open']);
    expect(split.pending.map((order) => order.id)).toEqual(['review', 'funding', 'cancelling']);
    expect(split.history.map((order) => order.id).sort()).toEqual(['cancelled', 'filled']);
  });

  it('defaults to Open, or Pending when Open is empty and Pending is not; ?tab= wins', () => {
    const pendingOnly = splitOrders([makeOrder({ status: 'EXECUTION_PENDING' })]);
    expect(defaultTab(null, null)).toBe('open');
    expect(defaultTab(null, pendingOnly)).toBe('pending');
    expect(defaultTab('history', pendingOnly)).toBe('history');
    expect(parseTab('pending')).toBe('pending');
    expect(parseTab('closed')).toBeNull();
  });

  it('refreshes 15 s on Open, 5 s on Pending and only on load or focus for History', () => {
    expect(refreshIntervalFor('open')).toBe(15_000);
    expect(refreshIntervalFor('pending')).toBe(5_000);
    expect(refreshIntervalFor('history')).toBe(false);
  });
});

describe('row sub-lines', () => {
  it('shows a sell minimum as proceeds, never the raw minOut (DD 4.1)', () => {
    expect(minimumLine(makeOrder())).toBe('min 230.00 PUSDTEST');
    expect(minimumLine(makeSellOrder())).toBe('min 0.052 BCH (proceeds)');
  });

  it('measures the distance to the limit from the rate now, for both sides', () => {
    // #given a buy limit of 460 PUSDTEST per BCH and a spot of 450 per BCH (1e8 sat per 45,000 units)
    const spot450 = { numerator: 100_000_000n, denominator: 45_000n };
    const buy = distanceToLimit(makeOrder(), spot450);
    expect(buy).not.toBeNull();
    expect(distanceLine(makeOrder(), spot450)).toBe('2.22% from the rate now');
    // A spot already at or past the limit gives no distance line.
    const spot470 = { numerator: 100_000_000n, denominator: 47_000n };
    expect(distanceLine(makeOrder(), spot470)).toBeNull();
    // Sell limit: 1,250 tokens for 0.052 BCH ≈ 24,038 per BCH; a spot of 25,000 per BCH is short.
    const spot25000 = { numerator: 100_000_000n, denominator: 2_500_000n };
    expect(distanceLine(makeSellOrder(), spot25000)).toBe('3.85% from the rate now');
    expect(distanceLine(makeOrder(), null)).toBeNull();
  });

  it('reads Received for a fill and Refunded for a cancel', () => {
    const filled = makeOrder({
      status: 'FILLED',
      settlement: {
        kind: 'fill',
        txid: SETTLEMENT_TXID,
        blockHeight: 925_118,
        confirmations: 3,
        received: 23_062n,
        surplus: 62n,
        poolOutpoint: { txid: 'ee'.repeat(32), vout: 0 },
        poolPkh: 'cd'.repeat(20),
        poolFeeSats: 150_000n,
        networkFeeSats: 783n,
        filledBy: 'atprice_keeper',
      },
    });
    expect(outcomeLine(filled)).toBe('Received 230.62 PUSDTEST');
    const cancelled = makeSellOrder({
      status: 'CANCELLED',
      settlement: {
        kind: 'cancel',
        txid: SETTLEMENT_TXID,
        blockHeight: 925_118,
        confirmations: 1,
        refundSats: 1_600n,
        refundTokens: 125_000n,
        networkFeeSats: 400n,
        refundAddress: 'bchtest:qz2s4qcqh2kq5hcmqf6lq4r8qzpnmqfpqv5jv0ewt7',
        authorizedBy: 'cancel',
      },
    });
    expect(outcomeLine(cancelled)).toBe('Refunded 1,250.00 PUSDTEST and 0.000016 BCH');
    expect(outcomeLine(makeOrder())).toBeNull();
  });

  it('takes the settlement txid from the settlement, or from a live fill or cancel event', () => {
    expect(settlementTxid(makeOrder())).toBeNull();
    const pending = makeOrder({
      status: 'EXECUTION_PENDING',
      events: [
        event(),
        event({ txid: SETTLEMENT_TXID, kind: 'execute', networkState: 'seen', confirmations: 0 }),
      ],
    });
    expect(settlementTxid(pending)).toBe(SETTLEMENT_TXID);
    const lost = makeOrder({
      events: [event(), event({ txid: SETTLEMENT_TXID, kind: 'cancel', networkState: 'conflicted' })],
    });
    expect(settlementTxid(lost)).toBeNull();
  });
});

describe('lookup and labels', () => {
  it('accepts a 64-hex txid in any case with spaces around it, and nothing else', () => {
    expect(normalizeTxid(`  ${FUNDING_TXID.toUpperCase()} `)).toBe(FUNDING_TXID);
    expect(normalizeTxid(FUNDING_TXID.slice(1))).toBeNull();
    expect(normalizeTxid(`${FUNDING_TXID}:0`)).toBeNull();
  });

  it('names a row the way orders.md reads it', () => {
    expect(orderRowName(makeOrder(), false)).toBe(
      'Buy PUSDTEST on BCH/PUSDTEST, 0.50 BCH, limit 460.00 PUSDTEST per BCH, Open, created 22 November 13:40 UTC',
    );
  });
});
