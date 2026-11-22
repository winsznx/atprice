import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MarketDetailPage } from '@/components/markets/market-detail-page';
import { identityOf, shortSymbol, tokensPerBch } from '@/components/markets/market-logic';
import { loadMarket, loadMarkets } from '@/components/markets/server-data';
import { marketBySlug, pairText } from '@/components/trade/market';
import { formatRateText } from '@/lib/format';
import { notFoundMetadata, pageMetadata } from '@/lib/seo';

interface Params {
  readonly params: Promise<{ slug: string }>;
}

const resolve = async (slug: string) => {
  const markets = await loadMarkets();
  if (!markets.ok) return { kind: 'unknown' as const };
  const summary = markets.value.find((market) => market.slug === slug);
  return summary === undefined ? { kind: 'missing' as const } : { kind: 'found' as const, summary };
};

/**
 * Link previews carry the pair, rate and observation time; the share card shows the pair only, never a
 * price (market-detail.md). With the API unreachable the bundled allowlist still names the pair.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolve(slug);
  if (resolved.kind === 'missing') return notFoundMetadata('Market not found');
  const path = `/markets/${slug}`;
  if (resolved.kind === 'unknown') {
    const listed = marketBySlug(slug);
    const pair = listed === undefined ? null : pairText(listed);
    return pageMetadata({
      title: pair ?? 'Market',
      shareTitle: `${pair ?? 'A Bitcoin Cash token market'} on AtPrice`,
      description: `${pair ?? 'Bitcoin Cash token'} limit orders on AtPrice, filled through Cauldron pools.`,
      path,
    });
  }
  const { summary } = resolved;
  const pair = `BCH / ${shortSymbol(summary.symbol)}`;
  const rate = tokensPerBch(summary.spotRate, summary.decimals);
  const description =
    rate === null
      ? `${pair} limit orders on AtPrice, filled through Cauldron pools.`
      : `${formatRateText(rate.numerator, rate.denominator)} ${shortSymbol(summary.symbol)} per BCH${
          summary.observedAt === null ? '' : `, observed ${new Date(summary.observedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
        }. Limit orders on AtPrice, filled through Cauldron pools.`;
  return pageMetadata({ title: pair, shareTitle: `${pair} on AtPrice`, description, path });
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
