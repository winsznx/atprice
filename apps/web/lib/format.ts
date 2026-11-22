/**
 * Every amount and rate becomes text here and nowhere else (DD section 4). Pure bigint maths: no
 * floating point touches a value. Grouping is fixed to en-US so a value never changes shape.
 */

export type AmountMode = 'exact' | 'compact';

const SATS_DECIMALS = 8;
/** Fee lines add the satoshi count below 0.001 BCH (DD 4). */
const FEE_SATS_SUFFIX_BELOW = 100_000n;
const RATE_SIGNIFICANT_DIGITS = 8;

const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);

export const groupDigits = (integerDigits: string): string =>
  integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const trimFraction = (fraction: string, minimum: number): string => {
  let end = fraction.length;
  while (end > minimum && fraction[end - 1] === '0') end -= 1;
  return fraction.slice(0, end);
};

/** Renders a non-negative base-unit amount with `decimals` places, exact or with trailing zeros trimmed. */
export const formatUnits = (units: bigint, decimals: number, mode: AmountMode): string => {
  if (units < 0n) throw new RangeError(`formatUnits takes a non-negative amount, got ${units}`);
  if (decimals === 0) return groupDigits(units.toString());
  const scale = pow10(decimals);
  const integer = groupDigits((units / scale).toString());
  const fraction = (units % scale).toString().padStart(decimals, '0');
  const shown = mode === 'exact' ? fraction : trimFraction(fraction, Math.min(2, decimals));
  return shown === '' ? integer : `${integer}.${shown}`;
};

export const formatBch = (sats: bigint, mode: AmountMode): string => formatUnits(sats, SATS_DECIMALS, mode);

export const formatToken = (units: bigint, decimals: number, mode: AmountMode): string =>
  formatUnits(units, decimals, mode);

export const formatSats = (sats: bigint): string => groupDigits(sats.toString());

/** `0.00000312 BCH (312 sat)` below 0.001 BCH, otherwise the BCH figure alone. */
export const formatFee = (sats: bigint, mode: AmountMode = 'exact'): string => {
  const bch = `${formatBch(sats, mode)} BCH`;
  return sats < FEE_SATS_SUFFIX_BELOW ? `${bch} (${formatSats(sats)} sat)` : bch;
};

export interface FormattedRate {
  /** The digits as shown, without the approximation prefix. */
  readonly value: string;
  /** True when rounding to 8 significant figures changed the value and the rate is an order term. */
  readonly approximate: boolean;
}

const roundHalfEven = (numerator: bigint, denominator: bigint): bigint => {
  const quotient = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  if (twiceRemainder > denominator) return quotient + 1n;
  if (twiceRemainder < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
};

/**
 * An exact rational rounded half-even to 8 significant figures, then trimmed to at least 2 decimals.
 * When the 8 figures end before the decimal point, no decimals are added (DD 4 "Rates").
 */
export const formatRate = (
  numerator: bigint,
  denominator: bigint,
  options: { readonly term: boolean } = { term: false },
): FormattedRate => {
  if (denominator <= 0n || numerator < 0n) throw new RangeError('formatRate takes a non-negative ratio');
  if (numerator === 0n) return { value: '0.00', approximate: false };
  const lower = pow10(RATE_SIGNIFICANT_DIGITS - 1);
  const upper = pow10(RATE_SIGNIFICANT_DIGITS);
  let shift = 0;
  const scaled = (k: number): bigint =>
    k >= 0 ? (numerator * pow10(k)) / denominator : numerator / (denominator * pow10(-k));
  while (scaled(shift) >= upper) shift -= 1;
  while (scaled(shift) < lower) shift += 1;
  const scaledNumerator = shift >= 0 ? numerator * pow10(shift) : numerator;
  const scaledDenominator = shift >= 0 ? denominator : denominator * pow10(-shift);
  let digits = roundHalfEven(scaledNumerator, scaledDenominator);
  const exact = scaledNumerator % scaledDenominator === 0n;
  if (digits === upper) {
    digits /= 10n;
    shift -= 1;
  }
  let value: string;
  if (shift <= 0) {
    value = groupDigits((digits * pow10(-shift)).toString());
  } else {
    const text = digits.toString().padStart(shift + 1, '0');
    const integer = groupDigits(text.slice(0, text.length - shift));
    value = `${integer}.${trimFraction(text.slice(text.length - shift), 2)}`;
  }
  return { value, approximate: options.term && !exact };
};

/** Plain-text form, with the `≈ ` prefix when the rounding changed an order-term rate. */
export const formatRateText = (
  numerator: bigint,
  denominator: bigint,
  options?: { readonly term: boolean },
): string => {
  const rate = formatRate(numerator, denominator, options);
  return rate.approximate ? `≈ ${rate.value}` : rate.value;
};

/** Satoshis per token base unit, as `@atprice/core` `PriceRatio` defines it. */
export interface SatsPerUnit {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export type RateOrientation = 'tokens_per_bch' | 'bch_per_token';

/** Converts a sats-per-base-unit ratio into the displayed orientation as an exact ratio. */
export const orientRate = (
  ratio: SatsPerUnit,
  tokenDecimals: number,
  orientation: RateOrientation,
): { readonly numerator: bigint; readonly denominator: bigint } => {
  const sats = pow10(SATS_DECIMALS);
  const units = pow10(tokenDecimals);
  return orientation === 'tokens_per_bch'
    ? { numerator: sats * ratio.denominator, denominator: ratio.numerator * units }
    : { numerator: ratio.numerator * units, denominator: ratio.denominator * sats };
};

/**
 * A ratio as a percentage with 2 decimals, half-even, signed with `+` or the Unicode minus. A nonzero
 * value that rounds to zero prints `< 0.01%` (DD 4 "Other rules").
 */
export const formatPercent = (
  numerator: bigint,
  denominator: bigint,
  options: { readonly signed: boolean } = { signed: false },
): string => {
  if (denominator <= 0n) throw new RangeError('formatPercent takes a positive denominator');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const hundredths = roundHalfEven(magnitude * 10_000n, denominator);
  const sign = options.signed ? (negative ? '−' : '+') : negative ? '−' : '';
  if (hundredths === 0n && magnitude !== 0n) return `${options.signed ? sign : ''}< 0.01%`;
  const text = `${groupDigits((hundredths / 100n).toString())}.${(hundredths % 100n).toString().padStart(2, '0')}`;
  return hundredths === 0n ? '0.00%' : `${sign}${text}%`;
};

/** Signed amount text: `+0.62` or `−0.62`, zero as `+0`-style per DD 4.1 (`+0 sat` on the G1 boundary). */
export const formatSignedUnits = (units: bigint, decimals: number, mode: AmountMode): string =>
  `${units < 0n ? '−' : '+'}${formatUnits(units < 0n ? -units : units, decimals, mode)}`;

/** Middle truncation for hashes and addresses (DD 7.11): first 8 and last 6 of the payload. */
export const truncateMiddle = (value: string, head = 8, tail = 6): string => {
  const payload = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  return payload.length <= head + tail + 1 ? payload : `${payload.slice(0, head)}…${payload.slice(-tail)}`;
};

/** `m:ss` for elapsed timers (`0:48`, `12:03`). Hours roll into minutes on purpose: waits stay short. */
export const formatElapsed = (milliseconds: number): string => {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
};

/** Spoken form for accessible names: `0 minutes 42 seconds`. */
export const formatElapsedSpoken = (milliseconds: number): string => {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
};

export const formatBlockHeight = (height: number): string => groupDigits(height.toString());

const SHORT_STEPS = [
  { exponent: 12, suffix: 'T' },
  { exponent: 9, suffix: 'B' },
  { exponent: 6, suffix: 'M' },
  { exponent: 3, suffix: 'K' },
] as const;

/**
 * DD 4's one rounded amount: markets-table liquidity as `12.4K`. Three significant figures, rounded
 * down so a short form never claims more than the pool holds; below 1,000 whole tokens the compact
 * exact form is used. The caller gives the exact value in the accessible name.
 */
export const shortUnits = (units: bigint, decimals: number): string => {
  const whole = units / 10n ** BigInt(decimals);
  for (const { exponent, suffix } of SHORT_STEPS) {
    const scale = 10n ** BigInt(exponent);
    if (whole < scale) continue;
    const digits = (whole / scale).toString().length;
    const fractionDigits = Math.max(0, 3 - digits);
    const scaled = (whole * 10n ** BigInt(fractionDigits)) / scale;
    return `${formatUnits(scaled, fractionDigits, 'compact').replace(/\.0+$/, '')}${suffix}`;
  }
  return formatToken(units, decimals, 'compact');
};

/** `45 seconds`, `3 minutes`, `2 hours`, `1 day`: whole units, rounded down, for stale-data ages. */
export const formatAge = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const unit = (value: number, noun: string) => `${value} ${noun}${value === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  return unit(Math.floor(hours / 24), 'day');
};
