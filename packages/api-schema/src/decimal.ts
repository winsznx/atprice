import { z } from 'zod';

/*
 * The API carries every amount as a decimal string (architecture.md "Persistence": numeric(78,0),
 * JSON carries decimal strings) so no value ever passes through a JavaScript number.
 */

const UNSIGNED = /^(0|[1-9]\d*)$/;
const SIGNED = /^-?(0|[1-9]\d*)$/;

export class DecimalStringError extends Error {
  readonly code = 'DECIMAL_STRING_INVALID';

  constructor(readonly value: string) {
    super(`DECIMAL_STRING_INVALID: "${value}" is not a canonical decimal integer`);
    this.name = 'DecimalStringError';
  }
}

/** Parses a canonical non-negative decimal integer (no sign, no leading zeros, no exponent). */
export const parseUnsignedDecimal = (value: string): bigint => {
  if (!UNSIGNED.test(value)) throw new DecimalStringError(value);
  return BigInt(value);
};

/** Parses a canonical signed decimal integer. `-0` is rejected as non-canonical. */
export const parseSignedDecimal = (value: string): bigint => {
  if (!SIGNED.test(value) || value === '-0') throw new DecimalStringError(value);
  return BigInt(value);
};

export const toDecimalString = (value: bigint): string => value.toString(10);

export const unsignedAmount = z
  .string()
  .regex(UNSIGNED, 'expected a non-negative decimal integer string')
  .transform((value) => BigInt(value));

export const positiveAmount = unsignedAmount.refine((value) => value > 0n, 'expected a positive amount');

export const signedAmount = z
  .string()
  .regex(SIGNED, 'expected a decimal integer string')
  .refine((value) => value !== '-0', 'non-canonical -0')
  .transform((value) => BigInt(value));
