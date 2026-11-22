import { describe, expect, it } from 'vitest';
import { aboveMinimum, displayMinimum, limitText } from './display';

const PUSDTEST = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';

describe('DD 4.1 minimums', () => {
  it('shows a buy minimum as minOut tokens', () => {
    expect(displayMinimum({ side: 'buy', amount: 50_000_000n, minOut: 23_000n })).toEqual({
      kind: 'tokens',
      units: 23_000n,
    });
  });

  it('shows a sell minimum as proceeds P = minOut - 2000, never the raw minOut', () => {
    expect(displayMinimum({ side: 'sell', amount: 10_000n, minOut: 102_000n })).toEqual({
      kind: 'sats',
      sats: 100_000n,
    });
  });

  it('pins the G1 boundary: a sell payout of exactly P + 2000 is +0 above the minimum', () => {
    const order = { side: 'sell' as const, amount: 10_000n, minOut: 102_000n };
    expect(aboveMinimum(order, 102_000n)).toBe(0n);
  });

  it('refuses a positive minimum for a sell with minOut at or below the reserve', () => {
    expect(displayMinimum({ side: 'sell', amount: 1n, minOut: 2_000n })).toEqual({
      kind: 'none',
      contractValue: 2_000n,
    });
  });

  it('derives the limit as tokens per BCH', () => {
    // 0.5 BCH for at least 230.00 PUSDTEST is a limit of 460 per BCH.
    expect(limitText({ side: 'buy', amount: 50_000_000n, minOut: 23_000n, tokenCategory: PUSDTEST })).toBe(
      '460.00 PUSDTEST per BCH',
    );
    // Selling 230.00 for at least 0.5 BCH of proceeds (minOut = P + 2000).
    expect(limitText({ side: 'sell', amount: 23_000n, minOut: 50_002_000n, tokenCategory: PUSDTEST })).toBe(
      '460.00 PUSDTEST per BCH',
    );
  });
});
