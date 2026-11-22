import { SELL_ORDER_SATS } from './constants.js';
import { InvalidOrderParamsError, QuoteError } from './errors.js';

/** Pool balances: satoshis and fungible token units. */
export interface PoolReserves {
  readonly sats: bigint;
  readonly tokens: bigint;
}

/** Cauldron charges 0.3% of the BCH moved, truncated: `|B0 - B1| * 3 / 1000`. */
export const cauldronTradeFee = (bchDelta: bigint): bigint =>
  ((bchDelta < 0n ? -bchDelta : bchDelta) * 3n) / 1000n;

/** The Cauldron V0 exchange rule: `(B1 - fee) * T1 >= B0 * T0`. */
export const satisfiesCauldronExchange = (before: PoolReserves, after: PoolReserves): boolean =>
  (after.sats - cauldronTradeFee(before.sats - after.sats)) * after.tokens >= before.sats * before.tokens;

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

const assertReserves = (pool: PoolReserves): void => {
  if (pool.sats <= 0n || pool.tokens <= 0n) {
    throw new QuoteError(
      'invalid_reserves',
      `pool reserves must be positive, got ${pool.sats} sats / ${pool.tokens} tokens`,
    );
  }
};

export interface BuyFill {
  readonly bchIn: bigint;
  readonly tokensOut: bigint;
  readonly poolFee: bigint;
  readonly poolAfter: PoolReserves;
}

/**
 * Tokens released for exactly `bchIn` satoshis: `T1 = ceil(B0*T0 / (B1 - fee))`. This is the best
 * fill the contract accepts, since one token more would break the pool rule.
 */
export const buyFill = (pool: PoolReserves, bchIn: bigint): BuyFill => {
  assertReserves(pool);
  if (bchIn <= 0n) throw new QuoteError('non_positive_input', `bchIn must be positive, got ${bchIn}`);
  const poolFee = cauldronTradeFee(bchIn);
  const sats = pool.sats + bchIn;
  const tokens = ceilDiv(pool.sats * pool.tokens, sats - poolFee);
  return { bchIn, tokensOut: pool.tokens - tokens, poolFee, poolAfter: { sats, tokens } };
};

export interface SellFill {
  readonly tokensIn: bigint;
  readonly bchOut: bigint;
  readonly poolFee: bigint;
  readonly poolAfter: PoolReserves;
}

/**
 * Largest `bchOut` for exactly `tokensIn` tokens: the maximum `d` with
 * `(B0 - d - floor(3d/1000)) * (T0 + tokensIn) >= B0*T0`. `d + floor(3d/1000)` is strictly
 * increasing, so the closed-form estimate `floor(R * 1000 / 1003)` is adjusted to the exact bound.
 */
export const sellFill = (pool: PoolReserves, tokensIn: bigint): SellFill => {
  assertReserves(pool);
  if (tokensIn <= 0n)
    throw new QuoteError('non_positive_input', `tokensIn must be positive, got ${tokensIn}`);
  const tokens = pool.tokens + tokensIn;
  const budget = pool.sats - ceilDiv(pool.sats * pool.tokens, tokens);
  const cost = (withdrawal: bigint): bigint => withdrawal + cauldronTradeFee(withdrawal);
  let bchOut = (budget * 1000n) / 1003n;
  while (cost(bchOut + 1n) <= budget) bchOut += 1n;
  while (bchOut > 0n && cost(bchOut) > budget) bchOut -= 1n;
  const poolFee = cauldronTradeFee(bchOut);
  return { tokensIn, bchOut, poolFee, poolAfter: { sats: pool.sats - bchOut, tokens } };
};

/** A price in satoshis per smallest token unit, as an exact ratio. */
export interface PriceRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const assertPrice = (price: PriceRatio): void => {
  if (price.numerator <= 0n || price.denominator <= 0n) {
    throw new InvalidOrderParamsError(
      'limit_price_invalid',
      'limit price numerator and denominator must be positive',
    );
  }
};

/**
 * Buy `minOut` for spending `spend` satoshis at no more than `maxPrice` sats per token unit:
 * the smallest integer `received` with `spend / received <= maxPrice`.
 */
export const buyMinOut = (spend: bigint, maxPrice: PriceRatio): bigint => {
  assertPrice(maxPrice);
  if (spend <= 0n) throw new InvalidOrderParamsError('amount_range', `spend must be positive, got ${spend}`);
  return ceilDiv(spend * maxPrice.denominator, maxPrice.numerator);
};

export interface SellMinOut {
  /** Minimum net proceeds P the user receives after the network fee. */
  readonly netProceeds: bigint;
  /** Contract `minOut`: P plus the order's own 2000 sats. */
  readonly minOut: bigint;
}

/** Sell minimum for `tokenAmount` tokens at no less than `minPrice` sats per token unit. */
export const sellMinOut = (tokenAmount: bigint, minPrice: PriceRatio): SellMinOut => {
  assertPrice(minPrice);
  if (tokenAmount <= 0n)
    throw new InvalidOrderParamsError('amount_range', `tokenAmount must be positive, got ${tokenAmount}`);
  return sellMinOutFromNetProceeds(ceilDiv(tokenAmount * minPrice.numerator, minPrice.denominator));
};

/** `minOut = P + 2000` (contract spec, sell execute). */
export const sellMinOutFromNetProceeds = (netProceeds: bigint): SellMinOut => {
  if (netProceeds < 1n)
    throw new InvalidOrderParamsError('min_out_range', `net proceeds must be at least 1, got ${netProceeds}`);
  return { netProceeds, minOut: netProceeds + SELL_ORDER_SATS };
};

/** The net proceeds P a sell `minOut` guarantees: what the UI shows instead of the raw figure. */
export const sellNetProceedsFromMinOut = (minOut: bigint): bigint => minOut - SELL_ORDER_SATS;
