import { QueryClient, isServer } from '@tanstack/react-query';
import { shouldRetry } from './queries';

const makeQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });

let browserQueryClient: QueryClient | undefined;

/** One client per browser tab, a fresh one per server render (TanStack v5 app-router guidance). */
export const getQueryClient = (): QueryClient => {
  if (isServer) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
};
