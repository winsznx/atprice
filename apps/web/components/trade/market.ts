import { SUPPORTED_MARKETS, type MarketDefinition } from '@atprice/core';
import { appNetwork } from '@/lib/network';

/*
 * Trade routes come from the allowlist bundled in `@atprice/core` (trade.md "Route"), so an unknown
 * slug is a 404 without an API call. The allowlist has no slug field yet (requested in
 * internal/specs/web-requests-trade.md), so the slug is derived from the verified symbol, the same
 * `bch-{symbol}` form the screen specs use.
 */

export const marketSlug = (market: Pick<MarketDefinition, 'symbol'>): string =>
  `bch-${market.symbol.toLowerCase()}`;

export const tradeMarkets = (): readonly MarketDefinition[] => SUPPORTED_MARKETS[appNetwork.network];

export const marketBySlug = (slug: string): MarketDefinition | undefined =>
  tradeMarkets().find((market) => marketSlug(market) === slug);

export const marketByCategory = (tokenCategory: string): MarketDefinition | undefined =>
  tradeMarkets().find((market) => market.tokenCategory === tokenCategory);

export const pairText = (market: Pick<MarketDefinition, 'symbol'>): string => `BCH / ${market.symbol}`;
