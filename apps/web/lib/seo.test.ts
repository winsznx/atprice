import { describe, expect, it } from 'vitest';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';
import { buildRobots, buildSitemap, NOINDEX, notFoundMetadata, pageMetadata, siteRobots, SITE_URL } from './seo';

const MARKETS = { marketSlugs: ['pusd'], tradeSlugs: ['bch-pusd'] };

describe('buildSitemap', () => {
  it('lists every indexable mainnet page with absolute URLs', () => {
    // #given the API's market slugs and the allowlist's trade slugs
    const urls = buildSitemap('mainnet', {
      marketSlugs: ['pusd', 'res'],
      tradeSlugs: ['bch-pusd', 'bch-res'],
    }).map((entry) => entry.url);

    // #then the public pages are listed under the site origin, in order
    expect(urls).toEqual([
      SITE_URL,
      `${SITE_URL}/markets`,
      `${SITE_URL}/markets/pusd`,
      `${SITE_URL}/markets/res`,
      `${SITE_URL}/trade/bch-pusd`,
      `${SITE_URL}/trade/bch-res`,
      `${SITE_URL}/evidence`,
      `${SITE_URL}/activity`,
      `${SITE_URL}/recover`,
    ]);
  });

  it('leaves out the redirect and every wallet or order page', () => {
    const paths = buildSitemap('mainnet', MARKETS).map((entry) => entry.url.slice(SITE_URL.length));
    expect(paths).not.toContain('/trade');
    expect(paths.some((path) => path.startsWith('/orders') || path === '/wallet')).toBe(false);
  });

  it('gives the home page the top priority and every entry a change frequency', () => {
    const entries = buildSitemap('mainnet', MARKETS);
    expect(entries[0]).toMatchObject({ url: SITE_URL, priority: 1, changeFrequency: 'weekly' });
    expect(entries.every((entry) => entry.changeFrequency !== undefined && entry.priority !== undefined)).toBe(true);
  });

  it('encodes slugs into the path', () => {
    const urls = buildSitemap('mainnet', { marketSlugs: ['a b'], tradeSlugs: [] }).map((entry) => entry.url);
    expect(urls).toContain(`${SITE_URL}/markets/a%20b`);
  });

  it('lists nothing for a chipnet build, which is what app/sitemap.ts serves in tests', async () => {
    expect(buildSitemap('chipnet', { marketSlugs: ['pusdtest'], tradeSlugs: ['bch-pusdtest'] })).toEqual([]);
    await expect(sitemap()).resolves.toEqual([]);
  });
});

describe('buildRobots', () => {
  it('allows crawling and points to the sitemap on mainnet', () => {
    expect(buildRobots('mainnet')).toEqual({
      rules: [{ userAgent: '*', allow: '/' }],
      sitemap: 'https://atprice.cash/sitemap.xml',
      host: 'https://atprice.cash',
    });
  });

  it('still allows crawling on chipnet, so the noindex tag can be read, but names no sitemap', () => {
    expect(buildRobots('chipnet')).toEqual({ rules: [{ userAgent: '*', allow: '/' }] });
    expect(robots()).toEqual(buildRobots('chipnet'));
  });
});

describe('pageMetadata', () => {
  it('sets the title, canonical and a full Open Graph and Twitter set for the path', () => {
    expect(pageMetadata({ title: 'Markets', description: 'Token markets.', path: '/markets' })).toEqual({
      title: 'Markets',
      description: 'Token markets.',
      alternates: { canonical: '/markets' },
      openGraph: {
        title: 'Markets · AtPrice',
        description: 'Token markets.',
        url: '/markets',
        siteName: 'AtPrice',
        locale: 'en_US',
        type: 'website',
      },
      twitter: { card: 'summary_large_image', title: 'Markets · AtPrice', description: 'Token markets.' },
    });
  });

  it('uses the share title when given and marks a non-indexable page noindex, follow', () => {
    const metadata = pageMetadata({
      title: 'Buy PUSD',
      shareTitle: 'Buy PUSD at 460.00 PUSD per BCH on AtPrice',
      description: 'Status: Open.',
      path: '/orders/abc',
      indexable: false,
    });
    expect(metadata.openGraph?.title).toBe('Buy PUSD at 460.00 PUSD per BCH on AtPrice');
    expect(metadata.twitter?.title).toBe('Buy PUSD at 460.00 PUSD per BCH on AtPrice');
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it('never sets images, so the route’s own opengraph-image is used', () => {
    const metadata = pageMetadata({ title: 'Evidence', description: 'Fills.', path: '/evidence' });
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).not.toHaveProperty('images');
  });
});

describe('siteRobots', () => {
  it('indexes the mainnet site with large image previews and keeps chipnet out of search', () => {
    expect(siteRobots('mainnet')).toMatchObject({ index: true, follow: true, googleBot: { 'max-image-preview': 'large' } });
    expect(siteRobots('chipnet')).toEqual(NOINDEX);
  });
});

describe('notFoundMetadata', () => {
  it('keeps a 404 out of search and drops the canonical and share tags it would inherit', () => {
    expect(notFoundMetadata('Order not found')).toEqual({
      title: 'Order not found',
      robots: { index: false, follow: true },
      alternates: { canonical: null },
      openGraph: null,
      twitter: null,
    });
  });
});
