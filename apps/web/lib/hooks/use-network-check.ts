'use client';

import { useQuery } from '@tanstack/react-query';
import { queries } from '../api/queries';
import { appNetwork } from '../network';

export type NetworkCheck =
  | { readonly status: 'checking' }
  | { readonly status: 'match' }
  /** Web build and API serve different networks: every order and cancel action is paused (DD 7.13). */
  | {
      readonly status: 'mismatch';
      readonly web: string;
      readonly api: string;
      readonly reason: 'network' | 'genesis';
    }
  /** The API didn't answer; the caller shows API_UNREACHABLE where it matters, not a mismatch. */
  | { readonly status: 'unknown'; readonly error: unknown };

/** The web build (`NEXT_PUBLIC_ATPRICE_NETWORK`) against `GET /api/v1/network` (architecture.md "Network"). */
export const useNetworkCheck = (): NetworkCheck => {
  const network = useQuery({ ...queries.network(), refetchInterval: 60_000 });
  if (network.data === undefined) {
    return network.isError ? { status: 'unknown', error: network.error } : { status: 'checking' };
  }
  if (network.data.network !== appNetwork.network) {
    return { status: 'mismatch', web: appNetwork.name, api: network.data.network, reason: 'network' };
  }
  if (network.data.genesisHash !== appNetwork.genesisHash) {
    return {
      status: 'mismatch',
      web: appNetwork.name,
      api: `${network.data.network} (different genesis)`,
      reason: 'genesis',
    };
  }
  return { status: 'match' };
};
