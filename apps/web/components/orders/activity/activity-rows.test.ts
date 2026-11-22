import { describe, expect, it } from 'vitest';
import { event, makeOrder, SETTLEMENT_TXID } from '../test-fixtures';
import { activityRows, amountParts, filterRows, parseKind, parseScope, replacement, stateText } from './activity-rows';

const filled = makeOrder({
  status: 'FILLED',
  events: [
    event(),
    event({ txid: SETTLEMENT_TXID, kind: 'execute', firstSeenAt: '2026-11-22T13:58:00.000Z', blockHeight: 925_110 }),
  ],
  settlement: {
    kind: 'fill',
    txid: SETTLEMENT_TXID,
    blockHeight: 925_110,
    confirmations: 1,
    received: 2_261n,
    surplus: 0n,
    poolOutpoint: { txid: 'ee'.repeat(32), vout: 0 },
    poolPkh: 'cd'.repeat(20),
    poolFeeSats: 0n,
    networkFeeSats: 783n,
    filledBy: 'atprice_keeper',
  },
});

describe('activityRows', () => {
  it('lists every transaction event of the orders, newest first', () => {
    expect(activityRows([filled]).map((row) => row.kind)).toEqual(['fill', 'funding']);
  });

  it('filters by kind and keeps all rows for All kinds', () => {
    const rows = activityRows([filled]);
    expect(filterRows(rows, 'funding').map((row) => row.kind)).toEqual(['funding']);
    expect(filterRows(rows, 'all')).toHaveLength(2);
  });

  it('shows a fill as input then received amount, wrapping after the arrow', () => {
    const [fillRow] = activityRows([filled]);
    if (fillRow === undefined) throw new Error('no row');
    expect(amountParts(fillRow)).toEqual({ first: '0.50 BCH →', second: '22.61 PUSDTEST' });
  });
});

describe('state and URL parameters', () => {
  it('speaks the attempt and the fact differently', () => {
    expect(stateText(event({ networkState: 'seen', confirmations: 0, blockHeight: null })).spoken).toBe(
      'Sent, not confirmed yet',
    );
    expect(stateText(event()).spoken).toBe('Confirmed in block 925,101');
  });

  it('names a replacement txid only when the API sends one', () => {
    expect(replacement(event({ networkState: 'replaced', conflict: SETTLEMENT_TXID }))).toEqual({
      txid: SETTLEMENT_TXID,
      text: null,
    });
    expect(replacement(event())).toEqual({ txid: null, text: null });
  });

  it('reads scope and kind from the URL, ignoring unknown values', () => {
    expect(parseScope('session')).toBe('session');
    expect(parseScope('everything')).toBeNull();
    expect(parseKind('cancel')).toBe('cancel');
    expect(parseKind('swap')).toBe('all');
  });
});
