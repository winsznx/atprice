import {
  MIN_RELAY_FEE_PER_BYTE,
  QuoteError,
  buyFill,
  executeFee,
  pinnedSupply,
  recipientAmount,
  sellFill,
  type EvaluatedOrderUtxo,
  type PoolReserves,
} from '@atprice/core';
import type { LivePool } from './reader.js';

/** Single-pool output for a supply: buy, token units released; sell, satoshis released. */
export interface PoolMaths {
  buy(reserves: PoolReserves, bchIn: bigint): bigint;
  sell(reserves: PoolReserves, tokensIn: bigint): bigint;
}

/** The keeper's maths: `packages/core`'s exact bigint quote (the evaluator uses a different implementation). */
export const CORE_MATHS: PoolMaths = {
  buy: (reserves, bchIn) => buyFill(reserves, bchIn).tokensOut,
  sell: (reserves, tokensIn) => sellFill(reserves, tokensIn).bchOut,
};

export interface PoolQuote {
  readonly pool: LivePool;
  readonly supply: bigint;
  readonly output: bigint;
  readonly recipientAmount: bigint;
}

/** The fee every execute pays at the keeper's rate, clamped to the order's allowance (core constant). */
export const keeperExecuteFee = (maxNetworkFee: bigint): bigint =>
  executeFee(MIN_RELAY_FEE_PER_BYTE, maxNetworkFee);

/** Quotes one pool, or undefined when the pool cannot take the supply. */
export const quotePool = (
  maths: PoolMaths,
  order: EvaluatedOrderUtxo,
  pool: LivePool,
  fee: bigint,
): PoolQuote | undefined => {
  const supply = pinnedSupply(order, fee);
  if (supply <= 0n) return undefined;
  try {
    const output =
      order.side === 'buy' ? maths.buy(pool.reserves, supply) : maths.sell(pool.reserves, supply);
    if (output <= 0n) return undefined;
    return { pool, supply, output, recipientAmount: recipientAmount(order, output, fee) };
  } catch (error) {
    if (error instanceof QuoteError) return undefined;
    throw error;
  }
};

/** The single pool with the largest output (D-010: one pool per fill; ties go to the earlier pool). */
export const bestPoolQuote = (
  maths: PoolMaths,
  order: EvaluatedOrderUtxo,
  pools: readonly LivePool[],
  fee: bigint,
): PoolQuote | undefined => {
  let best: PoolQuote | undefined;
  for (const pool of pools) {
    const quote = quotePool(maths, order, pool, fee);
    if (quote !== undefined && (best === undefined || quote.output > best.output)) best = quote;
  }
  return best;
};
