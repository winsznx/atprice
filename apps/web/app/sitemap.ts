import type { MetadataRoute } from 'next';
import { loadMarkets } from '@/components/markets/server-data';
import { marketSlug, tradeMarkets } from '@/components/trade/market';
import { publicEnv } from '@/lib/env/public';
import { buildSitemap, isIndexedNetwork } from '@/lib/seo';

/**
 * Market pages are keyed by the API's slugs, so they come from the live listing; trade pages come from
 * the bundled allowlist that decides which trade routes exist. With the API unreachable, the market
 * pages are left out for that response rather than guessed (loadMarkets logs the failure).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!isIndexedNetwork(publicEnv.network)) return [];
  const markets = await loadMarkets();
  return buildSitemap(publicEnv.network, {
    marketSlugs: markets.ok ? markets.value.map((market) => market.slug) : [],
    tradeSlugs: tradeMarkets().map(marketSlug),
  });
}
