import type { OrderSide } from '@atprice/core';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api } from './client';
import { isApiError } from './errors';
import type { Outpoint } from './schemas';

/**
 * Query keys and options for every endpoint. Screens call `useQuery(queries.market(tokenId))` and may
 * override `refetchInterval` per their spec's refresh column; they never build keys by hand, so an
 * invalidation in one place reaches every screen.
 */
export const queryKeys = {
  all: ['atprice'] as const,
  network: () => [...queryKeys.all, 'network'] as const,
  health: () => [...queryKeys.all, 'health'] as const,
  markets: () => [...queryKeys.all, 'markets'] as const,
  market: (tokenId: string) => [...queryKeys.markets(), tokenId] as const,
  quote: (tokenId: string, side: OrderSide, amount: bigint) =>
    [...queryKeys.market(tokenId), 'quote', side, amount.toString()] as const,
  orders: () => [...queryKeys.all, 'orders'] as const,
  order: (id: string) => [...queryKeys.orders(), 'id', id] as const,
  ordersByAddress: (address: string) => [...queryKeys.orders(), 'address', address] as const,
  ordersByOutpoints: (outpoints: readonly Outpoint[]) =>
    [
      ...queryKeys.orders(),
      'outpoints',
      outpoints.map(({ txid, vout }) => `${txid}:${vout}`).join(','),
    ] as const,
  orderExecutions: (id: string) => [...queryKeys.order(id), 'executions'] as const,
  execution: (id: string) => [...queryKeys.all, 'execution', id] as const,
  evidence: (cursor: string | null) => [...queryKeys.all, 'evidence', cursor ?? 'first'] as const,
  evidencePages: (limit: number) => [...queryKeys.all, 'evidence', 'pages', limit] as const,
} as const;

export const queries = {
  network: () =>
    queryOptions({ queryKey: queryKeys.network(), queryFn: ({ signal }) => api.network({ signal }) }),
  health: () =>
    queryOptions({ queryKey: queryKeys.health(), queryFn: ({ signal }) => api.health({ signal }) }),
  markets: () =>
    queryOptions({ queryKey: queryKeys.markets(), queryFn: ({ signal }) => api.markets({ signal }) }),
  market: (tokenId: string) =>
    queryOptions({
      queryKey: queryKeys.market(tokenId),
      queryFn: ({ signal }) => api.market(tokenId, { signal }),
    }),
  quote: (tokenId: string, side: OrderSide, amount: bigint) =>
    queryOptions({
      queryKey: queryKeys.quote(tokenId, side, amount),
      queryFn: ({ signal }) => api.quote(tokenId, side, amount, { signal }),
    }),
  order: (id: string) =>
    queryOptions({ queryKey: queryKeys.order(id), queryFn: ({ signal }) => api.order(id, { signal }) }),
  ordersByAddress: (address: string) =>
    queryOptions({
      queryKey: queryKeys.ordersByAddress(address),
      queryFn: ({ signal }) => api.ordersByAddress(address, { signal }),
    }),
  ordersByOutpoints: (outpoints: readonly Outpoint[]) =>
    queryOptions({
      queryKey: queryKeys.ordersByOutpoints(outpoints),
      queryFn: ({ signal }) => api.ordersByOutpoints(outpoints, { signal }),
    }),
  orderExecutions: (id: string) =>
    queryOptions({
      queryKey: queryKeys.orderExecutions(id),
      queryFn: ({ signal }) => api.orderExecutions(id, { signal }),
    }),
  execution: (id: string) =>
    queryOptions({
      queryKey: queryKeys.execution(id),
      queryFn: ({ signal }) => api.execution(id, { signal }),
    }),
  evidence: (cursor: string | null = null, limit?: number) =>
    queryOptions({
      queryKey: [...queryKeys.evidence(cursor), limit ?? 'default'],
      queryFn: ({ signal }) =>
        api.evidence({ cursor, ...(limit === undefined ? {} : { limit }) }, { signal }),
    }),
  /** Evidence as `Load older` pages, each continuing from the previous page's `nextCursor`. */
  evidencePages: (limit: number) =>
    infiniteQueryOptions({
      queryKey: queryKeys.evidencePages(limit),
      queryFn: ({ pageParam, signal }) => api.evidence({ cursor: pageParam, limit }, { signal }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
} as const;

/** Retry transport failures, never a schema mismatch or a named 4xx: those won't change on retry. */
export const shouldRetry = (failureCount: number, error: unknown): boolean => {
  if (failureCount >= 2) return false;
  if (!isApiError(error)) return false;
  if (error.code === 'API_RESPONSE_INVALID') return false;
  if (error.code === 'API_ERROR' && error.status !== null && error.status < 500) return false;
  return true;
};
