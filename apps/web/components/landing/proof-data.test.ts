import { describe, expect, it } from 'vitest';
import { evidenceOrder } from '@/components/evidence/evidence.fixtures';
import type { EvidenceOrder } from '@/lib/api/schemas';
import { aboveMinimumParts, latestFill, proofCounts, type FilledOrder } from './proof-data';

const cancelled = (fundingTxid: string, height: number): EvidenceOrder =>
  evidenceOrder({
    fundingTxid,
    status: 'CANCELLED',
    settlement: {
      kind: 'cancel',
      txid: 'c'.repeat(64),
      blockHeight: height,
      confirmations: 1,
      refundSats: 4_999_600n,
      refundTokens: 0n,
      networkFeeSats: 400n,
      refundAddress: 'bchtest:x',
      authorizedBy: 'cancel',
    },
    settlementBlock: { height, time: '2026-11-22T14:00:00.000Z' },
  });

const filled = (fundingTxid: string, received: bigint, filledBy: 'atprice_keeper' | 'other'): FilledOrder => {
  const order = evidenceOrder({ fundingTxid });
  if (order.settlement.kind !== 'fill') throw new Error('fixture is a fill');
  return { ...order, settlement: { ...order.settlement, received, filledBy } };
};

describe('latestFill', () => {
  it('skips newer cancels and returns the newest fill', () => {
    const fill = filled('2'.repeat(64), 2_261n, 'atprice_keeper');
    expect(latestFill([cancelled('1'.repeat(64), 925_120), fill])).toBe(fill);
  });

  it('is null when only cancels are listed, so the hero never invents a receipt', () => {
    expect(latestFill([cancelled('1'.repeat(64), 925_120)])).toBeNull();
    expect(latestFill([])).toBeNull();
  });
});

describe('proofCounts', () => {
  it('counts only what the page lists and says whether that is everything', () => {
    const orders = [
      cancelled('1'.repeat(64), 925_120),
      filled('2'.repeat(64), 2_261n, 'atprice_keeper'),
      filled('3'.repeat(64), 2_250n, 'other'),
    ];
    expect(proofCounts(orders, 'cursor')).toEqual({
      counted: 3,
      complete: false,
      fills: 2,
      cancels: 1,
      fillsAboveMinimum: 1,
      keeperFills: 1,
      newestBlock: 925_120,
    });
    expect(proofCounts(orders, null).complete).toBe(true);
  });

  it('has no newest block for an empty page', () => {
    expect(proofCounts([], null).newestBlock).toBeNull();
  });
});

describe('aboveMinimumParts', () => {
  it('signs the surplus in the payout unit with its share of the minimum', () => {
    expect(aboveMinimumParts(filled('2'.repeat(64), 2_261n, 'atprice_keeper'))).toEqual({
      amount: '+0.11 PUSDTEST',
      percent: '+0.49%',
    });
  });

  it('prints a fill at exactly the minimum as zero above', () => {
    expect(aboveMinimumParts(filled('2'.repeat(64), 2_250n, 'other'))).toEqual({
      amount: '+0.00 PUSDTEST',
      percent: '0.00%',
    });
  });
});
