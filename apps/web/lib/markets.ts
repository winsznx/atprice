import type { MarketSummary } from './api/schemas';
import { marketOf } from './orders/display';

/**
 * The market `/` shows and `/trade` redirects to (landing.md and trade.md "Route"): open for orders,
 * a verified token from the bundled allowlist, and the most liquidity. Liquidity is compared on the
 * BCH side, the one unit every pool shares; a tie keeps the server's order. A low-liquidity market is
 * never the default, so a visitor's first ticket isn't one that may never fill.
 */
export const defaultMarket = (markets: readonly MarketSummary[]): MarketSummary | undefined => {
  let best: MarketSummary | undefined;
  for (const market of markets) {
    if (market.availability !== 'open' || !market.verified) continue;
    if (marketOf(market.tokenId) === undefined) continue;
    if (best === undefined || market.liquidity.sats > best.liquidity.sats) best = market;
  }
  return best;
};
