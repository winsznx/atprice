import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MarketDetailPage } from '@/components/markets/market-detail-page';
import { identityOf, shortSymbol, tokensPerBch } from '@/components/markets/market-logic';
import { loadMarket, loadMarkets } from '@/components/markets/server-data';
import { formatRateText } from '@/lib/format';

interface Params {
  readonly params: Promise<{ slug: string }>;
}

const resolve = async (slug: string) => {
  const markets = await loadMarkets();
  if (!markets.ok) return { kind: 'unknown' as const };
  const summary = markets.value.find((market) => market.slug === slug);
  return summary === undefined ? { kind: 'missing' as const } : { kind: 'found' as const, summary };
};

/** Link previews carry the pair, rate and observation time; no generated price image (market-detail.md). */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolve(slug);
  if (resolved.kind !== 'found') return { title: 'Market' };
  const { summary } = resolved;
  const pair = `BCH / ${shortSymbol(summary.symbol)}`;
  const rate = tokensPerBch(summary.spotRate, summary.decimals);
  const description =
    rate === null
      ? `${pair} limit orders on AtPrice, filled through Cauldron pools.`
      : `${formatRateText(rate.numerator, rate.denominator)} ${shortSymbol(summary.symbol)} per BCH${
          summary.observedAt === null ? '' : `, observed ${new Date(summary.observedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
        }. Limit orders on AtPrice, filled through Cauldron pools.`;
  return {
    title: pair,
    description,
    openGraph: { title: `${pair} on AtPrice`, description },
  };
}

export default async function MarketDetailRoute({ params }: Params) {
  const { slug } = await params;
  const resolved = await resolve(slug);
  if (resolved.kind === 'missing') notFound();
  const detail = resolved.kind === 'found' ? await loadMarket(resolved.summary.tokenId) : null;
  const identity =
    resolved.kind !== 'found'
      ? null
      : identityOf(detail?.ok === true ? detail.value : resolved.summary);
  return (
    <div className="mx-auto w-full max-w-(--container-app) px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12">
      <MarketDetailPage slug={slug} identity={identity} initialDetail={detail?.ok === true ? detail.value : null} />
    </div>
  );
}
