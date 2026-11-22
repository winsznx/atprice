import type { Network } from '@atprice/core';
import type { Metadata, MetadataRoute } from 'next';

export const SITE_URL = 'https://atprice.cash';
export const SITE_NAME = 'AtPrice';
export const SITE_LOCALE = 'en_US';

export const HOME_TITLE = 'AtPrice · Limit orders for Bitcoin Cash tokens';
export const HOME_DESCRIPTION =
  'Non-custodial limit orders for CashTokens on Bitcoin Cash, filled through Cauldron pools. The contract enforces your minimum, and you can cancel any time.';

export const SITE_KEYWORDS = [
  'Bitcoin Cash',
  'BCH',
  'CashTokens',
  'limit order',
  'Cauldron',
  'DEX',
  'non-custodial',
  'covenant',
  'WizardConnect',
] as const;

/** Only the mainnet build is the public site. A chipnet build is a test deployment and stays out of search. */
export const isIndexedNetwork = (network: Network): boolean => network === 'mainnet';

/**
 * Pages about one wallet or one person's order. They stay crawlable, so link-preview bots can still fetch
 * the Open Graph tags, but ask search engines not to list them.
 */
export const NOINDEX: NonNullable<Metadata['robots']> = { index: false, follow: true };

export const siteRobots = (network: Network): NonNullable<Metadata['robots']> =>
  isIndexedNetwork(network)
    ? {
        index: true,
        follow: true,
        googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
      }
    : NOINDEX;

/**
 * A 404 page: noindex, and no canonical or share tags inherited from the home page, so a dead link
 * neither points search engines at `/` nor unfurls as the home card.
 */
export const notFoundMetadata = (title: string): Metadata => ({
  title,
  robots: NOINDEX,
  alternates: { canonical: null },
  openGraph: null,
  twitter: null,
});

interface PageSeo {
  /** The `<title>` before the root template adds ` · AtPrice`. */
  readonly title: string;
  /** Open Graph and Twitter title. Defaults to the full `<title>`. */
  readonly shareTitle?: string | undefined;
  readonly description: string;
  readonly path: string;
  readonly indexable?: boolean | undefined;
}

/**
 * Title, canonical, Open Graph and Twitter tags for one page. A segment's `openGraph` replaces its
 * parent's instead of merging, so every page sets the whole object. The image comes from the route's
 * own `opengraph-image.tsx`; a page that calls this without one loses the root card.
 */
export const pageMetadata = ({ title, shareTitle, description, path, indexable = true }: PageSeo): Metadata => {
  const share = shareTitle ?? `${title} · ${SITE_NAME}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title: share, description, url: path, siteName: SITE_NAME, locale: SITE_LOCALE, type: 'website' },
    twitter: { card: 'summary_large_image', title: share, description },
    ...(indexable ? {} : { robots: NOINDEX }),
  };
};

export interface SitemapMarkets {
  /** `/markets/[slug]` uses the API's slugs (`pusd`). */
  readonly marketSlugs: readonly string[];
  /** `/trade/[slug]` uses the bundled allowlist's slugs (`bch-pusd`). */
  readonly tradeSlugs: readonly string[];
}

/**
 * Every indexable page. `/trade` is left out because it redirects to a market, and `/orders`,
 * `/orders/[id]` and `/wallet` because they are noindex. A test network lists nothing.
 */
export const buildSitemap = (network: Network, { marketSlugs, tradeSlugs }: SitemapMarkets): MetadataRoute.Sitemap => {
  if (!isIndexedNetwork(network)) return [];
  const entry = (
    path: string,
    changeFrequency: NonNullable<MetadataRoute.Sitemap[number]['changeFrequency']>,
    priority: number,
  ): MetadataRoute.Sitemap[number] => ({ url: `${SITE_URL}${path}`, changeFrequency, priority });
  return [
    entry('', 'weekly', 1),
    entry('/markets', 'hourly', 0.8),
    ...marketSlugs.map((slug) => entry(`/markets/${encodeURIComponent(slug)}`, 'hourly', 0.7)),
    ...tradeSlugs.map((slug) => entry(`/trade/${encodeURIComponent(slug)}`, 'daily', 0.7)),
    entry('/evidence', 'hourly', 0.6),
    entry('/activity', 'hourly', 0.5),
    entry('/recover', 'monthly', 0.5),
  ];
};

/**
 * Crawling is allowed on every network: a noindex tag only works on a page the crawler may fetch, and
 * link-preview bots honour robots.txt. Only the public site points to a sitemap.
 */
export const buildRobots = (network: Network): MetadataRoute.Robots => ({
  rules: [{ userAgent: '*', allow: '/' }],
  ...(isIndexedNetwork(network) ? { sitemap: `${SITE_URL}/sitemap.xml`, host: SITE_URL } : {}),
});
