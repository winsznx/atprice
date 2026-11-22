import { describe, expect, it } from 'vitest';
import { formatAge, formatBch, formatFee, formatPercent, formatRate, formatToken, shortUnits } from './format';

describe('DD 4 amount modes', () => {
  it.each([
    [50_000_000n, '0.50000000', '0.50'],
    [50_002_600n, '0.50002600', '0.500026'],
    [5_310_000n, '0.05310000', '0.0531'],
    [2_000n, '0.00002000', '0.00002'],
    [1n, '0.00000001', '0.00000001'],
    [0n, '0.00000000', '0.00'],
    [123_456_789_000n, '1,234.56789000', '1,234.56789'],
  ])('formatBch(%s)', (sats, exact, compact) => {
    expect(formatBch(sats, 'exact')).toBe(exact);
    expect(formatBch(sats, 'compact')).toBe(compact);
  });

  it('formats tokens at their decimals', () => {
    expect(formatToken(23_000n, 2, 'exact')).toBe('230.00');
    expect(formatToken(1_250_000_000_000n, 6, 'exact')).toBe('1,250,000.000000');
    expect(formatToken(1_250_000_000_000n, 6, 'compact')).toBe('1,250,000.00');
    expect(formatToken(7n, 0, 'compact')).toBe('7');
  });

  it('adds sats to fees under 0.001 BCH', () => {
    expect(formatFee(312n)).toBe('0.00000312 BCH (312 sat)');
    expect(formatFee(100_000n)).toBe('0.00100000 BCH');
  });
});

describe('DD 4 rates and percentages', () => {
  it('rounds to 8 significant figures and marks changed order terms', () => {
    expect(formatRate(23_000n, 50n)).toEqual({ value: '460.00', approximate: false });
    expect(formatRate(1n, 3n, { term: true })).toEqual({ value: '0.33333333', approximate: true });
    expect(formatRate(1n, 3n)).toEqual({ value: '0.33333333', approximate: false });
    expect(formatRate(24_038_462n, 1n).value).toBe('24,038,462');
  });

  it('never prints a nonzero percentage as zero', () => {
    expect(formatPercent(42n, 10_000n)).toBe('0.42%');
    expect(formatPercent(1n, 10_000_000n)).toBe('< 0.01%');
    expect(formatPercent(-110n, 10_000n, { signed: true })).toBe('−1.10%');
  });
});

describe('DD 4 rounded amount and stale-data age', () => {
  it('shortens liquidity to three figures, rounding down, and nothing else', () => {
    expect(shortUnits(1_240_255n, 2)).toBe('12.4K');
    expect(shortUnits(100_000n, 2)).toBe('1K');
    expect(shortUnits(12_000_000_000n, 2)).toBe('120M');
    expect(shortUnits(99_950n, 2)).toBe('999.50');
  });

  it('names an age in whole units, rounded down', () => {
    expect(formatAge(59_999)).toBe('59 seconds');
    expect(formatAge(60_000)).toBe('1 minute');
    expect(formatAge(3 * 3_600_000)).toBe('3 hours');
  });
});
