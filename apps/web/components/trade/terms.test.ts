import { describe, expect, it } from 'vitest';
import {
  limitToPrice,
  limitVersusRate,
  minimumTerms,
  offsetLimitText,
  parseAmount,
  parseDecimal,
  parseLimit,
  ratioInputText,
  sanitizeDecimalInput,
  unitsInputText,
} from './terms';

describe('parseDecimal', () => {
  it('reads digits and one point exactly', () => {
    expect(parseDecimal('0.50', 8)).toEqual({ kind: 'ok', value: { digits: 50n, scale: 2 } });
    expect(parseDecimal('12', 2)).toEqual({ kind: 'ok', value: { digits: 12n, scale: 0 } });
    expect(parseDecimal('.5', 2)).toEqual({ kind: 'ok', value: { digits: 5n, scale: 1 } });
  });

  it('rejects more decimals than the asset has instead of rounding', () => {
    expect(parseDecimal('1.234', 2)).toEqual({ kind: 'too_precise', maxDecimals: 2 });
  });

  it('treats blank input as empty and other characters as invalid', () => {
    expect(parseDecimal('  ', 2)).toEqual({ kind: 'empty' });
    expect(parseDecimal('1e5', 2)).toEqual({ kind: 'invalid' });
  });
});

describe('sanitizeDecimalInput', () => {
  it('keeps digits and the first separator, reading a comma as the point', () => {
    expect(sanitizeDecimalInput(' 1,250.5x')).toBe('1.2505');
    expect(sanitizeDecimalInput('0.5.1')).toBe('0.51');
  });
});

describe('parseAmount', () => {
  it('converts BCH to satoshis', () => {
    expect(parseAmount('0.5', 8, 'BCH')).toEqual({ kind: 'ok', units: 50_000_000n });
  });

  it('names the token precision when too many decimals are typed', () => {
    expect(parseAmount('1.001', 2, 'PUSD')).toEqual({
      kind: 'invalid',
      message: 'PUSD has 2 decimals. Enter at most 2 digits after the point.',
    });
  });

  it('counts zero as no amount', () => {
    expect(parseAmount('0.00', 8, 'BCH')).toEqual({ kind: 'empty' });
  });
});

describe('limit prices', () => {
  it('turns 460.00 PUSD per BCH into satoshis per PUSD base unit', () => {
    const price = limitToPrice({ digits: 46_000n, scale: 2 }, 'tokens_per_bch', 2);
    expect(price).toEqual({ numerator: 10_000_000_000n, denominator: 4_600_000n });
  });

  it('gives the same order whichever unit the limit was typed in', () => {
    const tokens = parseLimit('400', 'tokens_per_bch', 2, 'PUSD');
    const bch = parseLimit('0.0025', 'bch_per_token', 2, 'PUSD');
    if (tokens.kind !== 'ok' || bch.kind !== 'ok') throw new Error('expected prices');
    expect(minimumTerms('buy', 50_000_000n, tokens.price)).toEqual(
      minimumTerms('buy', 50_000_000n, bch.price),
    );
  });

  it('rejects a zero limit as empty', () => {
    expect(parseLimit('0', 'tokens_per_bch', 2, 'PUSD')).toEqual({ kind: 'empty' });
  });
});

describe('minimumTerms (core buyMinOut / sellMinOut)', () => {
  it('buy 0.5 BCH at 460.00 PUSD per BCH receives at least 230.00 PUSD', () => {
    const limit = parseLimit('460.00', 'tokens_per_bch', 2, 'PUSD');
    if (limit.kind !== 'ok') throw new Error('expected a price');
    expect(minimumTerms('buy', 50_000_000n, limit.price)).toEqual({ minOut: 23_000n, minProceeds: 23_000n });
  });

  it('sell shows proceeds P and stores minOut = P + 2000 (DD 4.1)', () => {
    const limit = parseLimit('500', 'tokens_per_bch', 2, 'PUSD');
    if (limit.kind !== 'ok') throw new Error('expected a price');
    // 1,250.00 PUSD at 500 PUSD per BCH is 2.5 BCH.
    expect(minimumTerms('sell', 125_000n, limit.price)).toEqual({
      minOut: 250_002_000n,
      minProceeds: 250_000_000n,
    });
  });
});

describe('limitVersusRate', () => {
  const rate = { numerator: 10_000_000_000n, denominator: 4_496_000n }; // 449.60 PUSD per BCH

  it('a buy limit above the rate in tokens per BCH needs a better rate', () => {
    const limit = { numerator: 10_000_000_000n, denominator: 4_600_000n }; // 460.00
    const fraction = limitVersusRate('buy', limit, rate);
    // (460.00 / 449.60) - 1 = 2.313...%
    expect(Number((fraction.numerator * 1_000_000n) / fraction.denominator)).toBe(23_131);
  });

  it('a sell limit below the rate is reachable now (negative)', () => {
    const limit = { numerator: 10_000_000_000n, denominator: 4_600_000n };
    expect(limitVersusRate('sell', limit, rate).numerator < 0n).toBe(true);
  });
});

describe('offsetLimitText', () => {
  const rate = { numerator: 10_000_000_000n, denominator: 4_496_000n }; // 449.60 PUSD per BCH

  it('Rate now writes the reference rate', () => {
    expect(offsetLimitText('buy', rate, 0, 'tokens_per_bch', 2)).toBe('449.60');
  });

  it('a buy offset rounds down in PUSD per BCH so it is never overstated', () => {
    // 449.60 * 1.01 = 454.096 -> 454.09
    expect(offsetLimitText('buy', rate, 100, 'tokens_per_bch', 2)).toBe('454.09');
  });

  it('a sell offset rounds up in PUSD per BCH (fewer BCH per token for the seller)', () => {
    // 449.60 / 1.01 = 445.148... -> 445.15
    expect(offsetLimitText('sell', rate, 100, 'tokens_per_bch', 2)).toBe('445.15');
  });

  it('in BCH per PUSD a buy rounds up and a sell rounds down', () => {
    // 1 / 449.60 = 0.002224199..., buy +1%: 0.002202177... -> 0.00220218
    expect(offsetLimitText('buy', rate, 100, 'bch_per_token', 2)).toBe('0.00220218');
    // sell +1%: 0.002246441... -> 0.00224644
    expect(offsetLimitText('sell', rate, 100, 'bch_per_token', 2)).toBe('0.00224644');
  });
});

describe('input text', () => {
  it('Max writes the compact value without grouping', () => {
    expect(unitsInputText(81_210_000n, 8)).toBe('0.8121');
    expect(unitsInputText(125_000n, 2)).toBe('1250');
    expect(unitsInputText(7n, 0)).toBe('7');
  });

  it('shows an inverted rate at the unit precision', () => {
    expect(ratioInputText({ numerator: 1n, denominator: 460n }, 8)).toBe('0.00217391');
  });
});
