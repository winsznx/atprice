import { apiOrigin } from './target';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * DD 5.10 review sizes: 390 x 844 and 1440 x 900 for every screen, plus the extra runs the screen
 * specs name: 320 x 568 (reflow floor), 320 x 256 and 844 x 390 (the short rule, landing.md and
 * trade.md), 768 (the two-column trade grid and two-column market cards) and 1024 x 768 (the tables
 * at their stated widths).
 */
export const VIEWPORTS: readonly Viewport[] = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
  { width: 320, height: 568 },
  { width: 320, height: 256 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
];

export interface Fixtures {
  /** A market slug the local API lists. */
  readonly marketSlug: string | null;
  /** A funding txid the local API knows. */
  readonly orderId: string | null;
}

export interface Route {
  /** File-name stem: `/` is `home`, dynamic segments are named, not filled in. */
  readonly name: string;
  readonly path: (fixtures: Fixtures) => string | { readonly skip: string };
}

const needs = (value: string | null, what: string, env: string): string | { skip: string } =>
  value ?? { skip: `the local API has no ${what} and ${env} is not set` };

/** Every route in internal/specs/screens/ (the dialogs, toasts and wallet panel are not routes). */
export const ROUTES: readonly Route[] = [
  { name: 'home', path: () => '/' },
  { name: 'trade', path: () => '/trade' },
  {
    name: 'trade-slug',
    path: ({ marketSlug }) => {
      const slug = needs(marketSlug, 'market', 'E2E_MARKET_SLUG');
      return typeof slug === 'string' ? `/trade/${slug}` : slug;
    },
  },
  { name: 'markets', path: () => '/markets' },
  {
    name: 'markets-slug',
    path: ({ marketSlug }) => {
      const slug = needs(marketSlug, 'market', 'E2E_MARKET_SLUG');
      return typeof slug === 'string' ? `/markets/${slug}` : slug;
    },
  },
  { name: 'orders', path: () => '/orders' },
  {
    name: 'orders-id',
    path: ({ orderId }) => {
      const id = needs(orderId, 'completed order', 'E2E_ORDER_ID');
      return typeof id === 'string' ? `/orders/${id}` : id;
    },
  },
  { name: 'activity', path: () => '/activity' },
  { name: 'evidence', path: () => '/evidence' },
  { name: 'wallet', path: () => '/wallet' },
  { name: 'recover', path: () => '/recover' },
];

const readJson = async (path: string): Promise<unknown> => {
  const response = await fetch(`${apiOrigin}/api/v1${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`);
  return response.json();
};

const firstString = (value: unknown, pick: (item: Record<string, unknown>) => unknown): string | null => {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const picked = pick(item as Record<string, unknown>);
    if (typeof picked === 'string' && picked.length > 0) return picked;
  }
  return null;
};

export interface FixtureSource {
  readonly fixtures: Fixtures;
  /** Why a value couldn't be read from the API, for the run's annotations. */
  readonly notes: readonly string[];
}

/** Dynamic segments come from the local API's own answers, or from the environment; never invented. */
export const loadFixtures = async (): Promise<FixtureSource> => {
  const notes: string[] = [];
  let marketSlug = process.env.E2E_MARKET_SLUG?.trim() || null;
  let orderId = process.env.E2E_ORDER_ID?.trim() || null;
  if (marketSlug === null) {
    try {
      const body = (await readJson('/markets')) as { markets?: unknown };
      marketSlug = firstString(body.markets, (market) => market.slug);
      if (marketSlug === null) notes.push('GET /markets listed no market with a slug');
    } catch (error) {
      notes.push(`GET /markets failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (orderId === null) {
    try {
      const body = (await readJson('/evidence?limit=1')) as { orders?: unknown };
      orderId = firstString(body.orders, (order) => {
        const funding = order.funding;
        return typeof funding === 'object' && funding !== null ? (funding as { txid?: unknown }).txid : null;
      });
      if (orderId === null) notes.push('GET /evidence listed no completed order');
    } catch (error) {
      notes.push(`GET /evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { fixtures: { marketSlug, orderId }, notes };
};
