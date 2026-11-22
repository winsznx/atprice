import { cache } from 'react';
import { api } from '@/lib/api/client';
import type { Order } from '@/lib/api/schemas';

/** A link preview must not wait on a slow API: past this, the page renders and the browser loads it. */
const SERVER_FETCH_MS = 3_000;

/**
 * The public record for link previews, the share card and first paint, fetched once per request. Any
 * failure is left to the browser, which shows the named not-found or error state; the server never guesses.
 */
export const loadPublicOrder = cache(async (txid: string): Promise<Order | null> => {
  try {
    return await api.order(txid, { signal: AbortSignal.timeout(SERVER_FETCH_MS) });
  } catch (error) {
    console.warn(`Server render of order ${txid} continues without its record:`, error);
    return null;
  }
});
