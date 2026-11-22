import { findMarket, SELL_ORDER_SATS, type MarketDefinition, type OrderSide } from '@atprice/core';
import type { Order } from '../api/schemas';
import { formatBch, formatRateText, formatToken, orientRate, type AmountMode } from '../format';
import { appNetwork } from '../network';

/*
 * DD 4.1 in one place: what a user sees as their minimum versus what the contract stores. Every screen
 * formats order terms through these helpers, so a sell's raw `minOut` (which includes the 2,000 sat
 * reserve) is never shown as a minimum or a price.
 */

export interface OrderTerms {
  readonly side: OrderSide;
  /** Buy: satoshis to spend. Sell: token units to sell. */
  readonly amount: bigint;
  readonly minOut: bigint;
}

export type MinimumDisplay =
  | { readonly kind: 'tokens'; readonly units: bigint }
  | { readonly kind: 'sats'; readonly sats: bigint }
  /** A sell with `minOut <= 2000` built by another tool: no positive minimum price exists. */
  | { readonly kind: 'none'; readonly contractValue: bigint };

/** `minProceeds` (DD 4.1): buy `minOut` tokens; sell `P = minOut - 2000` sats. */
export const displayMinimum = (terms: OrderTerms): MinimumDisplay => {
  if (terms.side === 'buy') return { kind: 'tokens', units: terms.minOut };
  const proceeds = terms.minOut - SELL_ORDER_SATS;
  return proceeds > 0n ? { kind: 'sats', sats: proceeds } : { kind: 'none', contractValue: terms.minOut };
};

/** "Above your minimum" on a receipt: buy `received - minOut`; sell `payout - minOut` (DD 4.1). */
export const aboveMinimum = (terms: OrderTerms, received: bigint): bigint => received - terms.minOut;

export const marketOf = (tokenCategory: string): MarketDefinition | undefined =>
  findMarket(appNetwork.network, tokenCategory);

/** `BCH / PUSD`, or the shortened category id for a token outside the allowlist. */
export const pairLabel = (tokenCategory: string): string =>
  `BCH / ${marketOf(tokenCategory)?.symbol ?? `${tokenCategory.slice(0, 6)}…${tokenCategory.slice(-4)}`}`;

export const tokenSymbol = (tokenCategory: string): string =>
  marketOf(tokenCategory)?.symbol ?? `${tokenCategory.slice(0, 6)}…${tokenCategory.slice(-4)}`;

const tokenText = (tokenCategory: string, units: bigint, mode: AmountMode): string => {
  const market = marketOf(tokenCategory);
  return market === undefined
    ? `${units.toString()} units of ${tokenSymbol(tokenCategory)}`
    : `${formatToken(units, market.decimals, mode)} ${market.symbol}`;
};

export const bchText = (sats: bigint, mode: AmountMode): string => `${formatBch(sats, mode)} BCH`;

/** What the order puts in: BCH for a buy, tokens for a sell. */
export const orderInputText = (
  order: Pick<Order, 'side' | 'amount' | 'tokenCategory'>,
  mode: AmountMode,
): string =>
  order.side === 'buy' ? bchText(order.amount, mode) : tokenText(order.tokenCategory, order.amount, mode);

/** The user's minimum in words, per DD 4.1. */
export const minimumText = (
  order: Pick<Order, 'side' | 'amount' | 'minOut' | 'tokenCategory'>,
  mode: AmountMode,
): string => {
  const minimum = displayMinimum(order);
  switch (minimum.kind) {
    case 'tokens':
      return tokenText(order.tokenCategory, minimum.units, mode);
    case 'sats':
      return bchText(minimum.sats, mode);
    case 'none':
      return `No minimum price: the contract value ${minimum.contractValue.toString()} sat does not exceed the 2,000 sat reserve.`;
  }
};

/** What a fill paid out: tokens for a buy, the payout output in BCH for a sell. */
export const receivedText = (
  order: Pick<Order, 'side' | 'tokenCategory'>,
  received: bigint,
  mode: AmountMode,
): string =>
  order.side === 'buy' ? tokenText(order.tokenCategory, received, mode) : bchText(received, mode);

/**
 * The order's limit as `{tokens} {SYM} per BCH`, derived from the terms (DD 4 "Rates": derived, 8
 * significant figures, `≈` when rounding changed it). Null for an order without a positive minimum.
 */
export const limitText = (
  order: Pick<Order, 'side' | 'amount' | 'minOut' | 'tokenCategory'>,
): string | null => {
  const market = marketOf(order.tokenCategory);
  if (market === undefined) return null;
  const minimum = displayMinimum(order);
  if (minimum.kind === 'none') return null;
  const satsPerUnit =
    minimum.kind === 'tokens'
      ? { numerator: order.amount, denominator: minimum.units }
      : { numerator: minimum.sats, denominator: order.amount };
  const oriented = orientRate(satsPerUnit, market.decimals, 'tokens_per_bch');
  return `${formatRateText(oriented.numerator, oriented.denominator, { term: true })} ${market.symbol} per BCH`;
};

/**
 * The `Filled at` rate in tokens per BCH, from what the order put in and what the fill paid out. A
 * sell's payout includes the 2,000 sat reserve, which is not part of the price, so it is taken off
 * first. Null when the market isn't bundled or either side is zero.
 */
export const fillRate = (
  order: Pick<Order, 'side' | 'amount' | 'tokenCategory'>,
  fill: { readonly received: bigint },
): { numerator: bigint; denominator: bigint } | null => {
  const market = marketOf(order.tokenCategory);
  if (market === undefined) return null;
  const ratio =
    order.side === 'buy'
      ? { numerator: order.amount, denominator: fill.received }
      : { numerator: fill.received - SELL_ORDER_SATS, denominator: order.amount };
  if (ratio.numerator <= 0n || ratio.denominator <= 0n) return null;
  const oriented = orientRate(ratio, market.decimals, 'tokens_per_bch');
  return oriented.denominator === 0n ? null : oriented;
};
