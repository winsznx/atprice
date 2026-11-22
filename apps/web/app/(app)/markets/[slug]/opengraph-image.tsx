import { shortSymbol } from '@/components/markets/market-logic';
import { loadMarkets } from '@/components/markets/server-data';
import { renderOgCard } from '@/lib/og/card';

export const alt = 'A Bitcoin Cash token market on AtPrice';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * The pair and what AtPrice does with it, named from the API listing like the page. No price: a rate in
 * a cached image goes stale (market-detail.md). Without the API the card stays generic.
 */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const markets = await loadMarkets();
  const summary = markets.ok ? markets.value.find((market) => market.slug === slug) : undefined;
  return renderOgCard({
    title: summary === undefined ? 'Bitcoin Cash token market' : `BCH / ${shortSymbol(summary.symbol)}`,
    description: 'Set a limit price and the order fills through a Cauldron pool once the market meets it.',
    label: 'Market',
    path: `/markets/${slug}`,
    note: 'Backed by Cauldron pools',
  });
}
