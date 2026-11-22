import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { marketBySlug, pairText } from '@/components/trade/market';
import { TradeScreen } from '@/components/trade/trade-screen';
import { notFoundMetadata, pageMetadata } from '@/lib/seo';

interface TradePageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export async function generateMetadata({ params }: TradePageProps): Promise<Metadata> {
  const { slug } = await params;
  const market = marketBySlug(slug);
  if (market === undefined) return notFoundMetadata('Market not found');
  const pair = pairText(market);
  return pageMetadata({
    title: `Trade ${pair}`,
    shareTitle: `Trade ${pair} on AtPrice`,
    description: `Place a ${pair} limit order on Bitcoin Cash. The order lives in its own contract and fills when one Cauldron pool pays your minimum. Cancel any time.`,
    path: `/trade/${slug}`,
  });
}

/** trade.md: the slug comes from the bundled allowlist, so an unknown one is a 404 with no API call. */
export default async function TradePage({ params, searchParams }: TradePageProps) {
  const market = marketBySlug((await params).slug);
  if (market === undefined) notFound();
  const query = await searchParams;
  const side = single(query.side);
  return (
    <TradeScreen
      tokenCategory={market.tokenCategory}
      initialSide={side === 'buy' || side === 'sell' ? side : null}
      draftId={single(query.draft)}
    />
  );
}
