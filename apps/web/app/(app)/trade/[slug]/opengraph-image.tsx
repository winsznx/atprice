import { marketBySlug, marketSlug, pairText, tradeMarkets } from '@/components/trade/market';
import { renderOgCard } from '@/lib/og/card';

export const alt = 'Place a limit order on AtPrice';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export function generateStaticParams(): { slug: string }[] {
  return tradeMarkets().map((market) => ({ slug: marketSlug(market) }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const market = marketBySlug((await params).slug);
  if (market === undefined) return new Response('Not found', { status: 404 });
  return renderOgCard({
    title: `Trade ${pairText(market)}`,
    description: 'Your order waits in its own contract and fills when one Cauldron pool pays your minimum.',
    label: 'Trade',
    path: `/trade/${marketSlug(market)}`,
    note: 'Cancel any time',
  });
}
