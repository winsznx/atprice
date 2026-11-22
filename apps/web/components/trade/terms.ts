import { buyMinOut, sellMinOut, type OrderSide, type PriceRatio } from '@atprice/core';
import { orientRate, type RateOrientation } from '@/lib/format';

/*
 * The ticket's exact arithmetic (DD 7.2, architecture.md "Order creation" step 1). Inputs are decimal
 * strings, prices are exact ratios in `@atprice/core`'s orientation (satoshis per token base unit), and
 * the minimum the contract enforces comes only from core's `buyMinOut` / `sellMinOut`.
 */

export const BCH_DECIMALS = 8;

const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);

export interface ParsedDecimal {
  /** The value scaled by `10 ** scale`. */
  readonly digits: bigint;
  readonly scale: number;
}

export type DecimalParse =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'too_precise'; readonly maxDecimals: number }
  | { readonly kind: 'ok'; readonly value: ParsedDecimal };

const DECIMAL = /^(\d*)(?:\.(\d*))?$/;

/** Parses a typed non-negative decimal. More decimals than `maxDecimals` is an error, never rounded. */
export const parseDecimal = (text: string, maxDecimals: number): DecimalParse => {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '.') return { kind: 'empty' };
  const match = DECIMAL.exec(trimmed);
  if (match === null) return { kind: 'invalid' };
  const integer = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > maxDecimals) return { kind: 'too_precise', maxDecimals };
  const digits = BigInt(`${integer === '' ? '0' : integer}${fraction}`);
  return { kind: 'ok', value: { digits, scale: fraction.length } };
};

/**
 * Keeps only digits and one decimal separator, so typing and pasting can't put anything else in the
 * field (DD 7.2 item 2). A comma counts as the separator. Excess decimals are kept, so the field can
 * say they are too many instead of silently truncating.
 */
export const sanitizeDecimalInput = (text: string): string => {
  let seenSeparator = false;
  let result = '';
  for (const char of text.replace(/,/g, '.')) {
    if (char >= '0' && char <= '9') result += char;
    else if (char === '.' && !seenSeparator) {
      seenSeparator = true;
      result += char;
    }
  }
  return result;
};

/** Base units of a typed amount at `decimals`. */
export const toBaseUnits = (value: ParsedDecimal, decimals: number): bigint =>
  value.digits * pow10(decimals - value.scale);

export type AmountParse =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'ok'; readonly units: bigint };

/** The amount field: BCH (8 decimals) for a buy, the token at its verified decimals for a sell. */
export const parseAmount = (text: string, decimals: number, unit: string): AmountParse => {
  const parsed = parseDecimal(text, decimals);
  switch (parsed.kind) {
    case 'empty':
      return { kind: 'empty' };
    case 'invalid':
      return { kind: 'invalid', message: 'Enter an amount using digits and one decimal point.' };
    case 'too_precise':
      return {
        kind: 'invalid',
        message:
          decimals === 0
            ? `${unit} has no decimals. Enter a whole number.`
            : `${unit} has ${decimals} decimals. Enter at most ${decimals} digits after the point.`,
      };
    case 'ok': {
      const units = toBaseUnits(parsed.value, decimals);
      return units === 0n ? { kind: 'empty' } : { kind: 'ok', units };
    }
  }
};

/** The display precision of a limit in `orientation`: token decimals, or BCH's 8 for the inverse. */
export const limitDecimals = (orientation: RateOrientation, tokenDecimals: number): number =>
  orientation === 'tokens_per_bch' ? tokenDecimals : BCH_DECIMALS;

export const limitUnit = (orientation: RateOrientation, symbol: string): string =>
  orientation === 'tokens_per_bch' ? `${symbol} per BCH` : `BCH per ${symbol}`;

/** A typed limit in a display orientation as core's price ratio (satoshis per token base unit). */
export const limitToPrice = (
  value: ParsedDecimal,
  orientation: RateOrientation,
  tokenDecimals: number,
): PriceRatio | null => {
  if (value.digits === 0n) return null;
  const sats = pow10(BCH_DECIMALS);
  const units = pow10(tokenDecimals);
  const scale = pow10(value.scale);
  return orientation === 'tokens_per_bch'
    ? { numerator: sats * scale, denominator: value.digits * units }
    : { numerator: value.digits * sats, denominator: scale * units };
};

export type LimitParse =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'ok'; readonly price: PriceRatio };

export const parseLimit = (
  text: string,
  orientation: RateOrientation,
  tokenDecimals: number,
  symbol: string,
): LimitParse => {
  const decimals = limitDecimals(orientation, tokenDecimals);
  const parsed = parseDecimal(text, decimals);
  switch (parsed.kind) {
    case 'empty':
      return { kind: 'empty' };
    case 'invalid':
      return { kind: 'invalid', message: 'Enter a price using digits and one decimal point.' };
    case 'too_precise':
      return {
        kind: 'invalid',
        message: `Prices in ${limitUnit(orientation, symbol)} have at most ${decimals} decimals.`,
      };
    case 'ok': {
      const price = limitToPrice(parsed.value, orientation, tokenDecimals);
      return price === null ? { kind: 'empty' } : { kind: 'ok', price };
    }
  }
};

/**
 * What the user receives at least (DD 4.1): a buy's `minOut` in token units, a sell's net proceeds
 * `P` in satoshis. `minOut` is what goes into the contract (for a sell, `P + 2000`).
 */
export interface MinimumTerms {
  readonly minOut: bigint;
  /** Buy: token units. Sell: satoshis of net proceeds. */
  readonly minProceeds: bigint;
}

export const minimumTerms = (side: OrderSide, amount: bigint, price: PriceRatio): MinimumTerms => {
  if (side === 'buy') {
    const minOut = buyMinOut(amount, price);
    return { minOut, minProceeds: minOut };
  }
  const { minOut, netProceeds } = sellMinOut(amount, price);
  return { minOut, minProceeds: netProceeds };
};

export interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * How much better `limit` is for the user than `reference`, as a signed fraction of the reference.
 * Buy: tokens per BCH at the limit over tokens per BCH now, minus one. Sell: BCH per token at the
 * limit over BCH per token now, minus one. Positive means the rate must move in the user's favour,
 * so the words follow the side, whichever way the price is displayed.
 */
export const limitVersusRate = (side: OrderSide, limit: PriceRatio, reference: PriceRatio): Fraction =>
  side === 'buy'
    ? {
        numerator: reference.numerator * limit.denominator - limit.numerator * reference.denominator,
        denominator: limit.numerator * reference.denominator,
      }
    : {
        numerator: limit.numerator * reference.denominator - reference.numerator * limit.denominator,
        denominator: reference.numerator * limit.denominator,
      };

/** The offset buttons, in basis points of the reference rate. */
export const OFFSETS_BPS = [0, 50, 100, 200, 500] as const;
export type OffsetBps = (typeof OFFSETS_BPS)[number];

export const offsetLabel = (bps: OffsetBps): string =>
  bps === 0 ? 'Rate now' : `+${(bps / 100).toString()}%`;

const floorDiv = (a: bigint, b: bigint): bigint => a / b;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

const plainDecimal = (scaled: bigint, decimals: number): string => {
  if (decimals === 0) return scaled.toString();
  const text = scaled.toString().padStart(decimals + 1, '0');
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`;
};

/**
 * The limit text an offset button writes (trade.md "Controls"): the reference rate moved `bps` in the
 * user's favour, then rounded to the display precision away from the user's favour, so the stated
 * offset is never overstated. Returned without grouping, as an input shows it (DD 4 "Inputs").
 */
export const offsetLimitText = (
  side: OrderSide,
  reference: PriceRatio,
  bps: OffsetBps,
  orientation: RateOrientation,
  tokenDecimals: number,
): string => {
  const factor = 10_000n + BigInt(bps);
  const moved: PriceRatio =
    side === 'buy'
      ? { numerator: reference.numerator * 10_000n, denominator: reference.denominator * factor }
      : { numerator: reference.numerator * factor, denominator: reference.denominator * 10_000n };
  const oriented = orientRate(moved, tokenDecimals, orientation);
  const decimals = limitDecimals(orientation, tokenDecimals);
  const scaledNumerator = oriented.numerator * pow10(decimals);
  // Buy favours more tokens per BCH (fewer BCH per token); sell favours the opposite.
  const roundDown = (side === 'buy') === (orientation === 'tokens_per_bch');
  const scaled = roundDown
    ? floorDiv(scaledNumerator, oriented.denominator)
    : ceilDiv(scaledNumerator, oriented.denominator);
  return plainDecimal(scaled, decimals);
};

/** `Max` for a sell (trade.md "Controls"): the full token balance, compact and ungrouped. */
export const unitsInputText = (units: bigint, decimals: number): string => {
  const text = plainDecimal(units, decimals);
  if (decimals === 0) return text;
  const trimmed = text.replace(/0+$/, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
};

/** Displays an exact ratio in an input after inverting the unit, ungrouped (DD 4 "Inputs"). */
export const ratioInputText = (ratio: Fraction, decimals: number): string =>
  unitsInputText(floorDiv(ratio.numerator * pow10(decimals), ratio.denominator), decimals);
