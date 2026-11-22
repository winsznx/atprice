import { unstable_rethrow } from 'next/navigation';
import { cache } from 'react';
import { api } from '@/lib/api/client';
import type { MarketDetail, MarketSummary } from '@/lib/api/schemas';

export type Loaded<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

const load = async <T>(read: () => Promise<T>, what: string): Promise<Loaded<T>> => {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    // Next's own render signals (dynamic usage, notFound) must pass through untouched.
    unstable_rethrow(error);
    // The page still renders; its client island shows the named failure state and retries.
    console.error(`Server render could not load ${what}:`, error);
    return { ok: false, error };
  }
};

/**
 * Server-side reads that seed the client queries (first paint has real data, and link previews carry
 * it). A failure here is not fatal: the client island owns the visible error state and Retry. Each read
 * is deduplicated per request, so `generateMetadata` and the page share one.
 */
export const loadMarkets = cache((): Promise<Loaded<readonly MarketSummary[]>> =>
  load(() => api.markets(), 'markets'),
);

export const loadMarket = cache((tokenId: string): Promise<Loaded<MarketDetail>> =>
  load(() => api.market(tokenId), `market ${tokenId}`),
);
