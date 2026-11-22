import { SUPPORTED_MARKETS, type MarketDefinition } from '@atprice/core';
import type { MarketSummary } from './api/schemas';
import { appNetwork } from './network';
import { marketOf } from './orders/display';

/**
 * The first open, verified market in `allowlist` order. The allowlist is curated per network, so its
 * order is the product's choice of which market a visitor sees first, not whichever pool is deepest.
 */
export const firstListedOpenMarket = (
  markets: readonly MarketSummary[],
  allowlist: readonly MarketDefinition[],
): MarketSummary | undefined => {
  for (const entry of allowlist) {
    const market = markets.find(
      (candidate) =>
        candidate.tokenId === entry.tokenCategory && candidate.availability === 'open' && candidate.verified,
    );
    if (market !== undefined) return market;
  }
  return undefined;
};

/**
 * The market `/trade` opens on: the first open, verified market of this build's network allowlist
 * (packages/core SUPPORTED_MARKETS). A low-liquidity market is never the default, so a visitor's first
 * ticket isn't one that may never fill.
 */
export const defaultMarket = (markets: readonly MarketSummary[]): MarketSummary | undefined =>
  firstListedOpenMarket(
    markets.filter((market) => marketOf(market.tokenId) !== undefined),
    SUPPORTED_MARKETS[appNetwork.network],
  );
