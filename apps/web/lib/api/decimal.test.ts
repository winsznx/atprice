import { describe, expect, it } from 'vitest';
import {
  DecimalStringError,
  parseSignedDecimal,
  parseUnsignedDecimal,
  signedAmount,
  unsignedAmount,
} from './decimal';

describe('decimal strings', () => {
  it('parses canonical integers beyond Number.MAX_SAFE_INTEGER exactly', () => {
    expect(parseUnsignedDecimal('9223372036854775807')).toBe(2n ** 63n - 1n);
    expect(parseSignedDecimal('-12')).toBe(-12n);
    expect(unsignedAmount.parse('0')).toBe(0n);
    expect(signedAmount.parse('-5')).toBe(-5n);
  });

  it.each(['', '01', '1.5', '1e3', ' 1', '+1', '0x10'])('rejects non-canonical unsigned %j', (value) => {
    expect(() => parseUnsignedDecimal(value)).toThrow(DecimalStringError);
    expect(unsignedAmount.safeParse(value).success).toBe(false);
  });

  it('rejects -0 and leading zeros on signed values', () => {
    expect(() => parseSignedDecimal('-0')).toThrow(DecimalStringError);
    expect(signedAmount.safeParse('-01').success).toBe(false);
  });
});
