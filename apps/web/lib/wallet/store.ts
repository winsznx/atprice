'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { getChain } from '../chain/client';
import { appNetwork } from '../network';
import { BALANCE_REFRESH_MS } from './constants';
import { WalletConnector, type WalletState } from './connector';
import type { OwnerIdentity } from './keys';
import { scanWallet, type WalletScan } from './scan';

let connector: WalletConnector | undefined;

/** The tab's connector. Browser only; `WalletProvider` starts it once on mount. */
export const getWalletConnector = (): WalletConnector => {
  connector ??= new WalletConnector(appNetwork);
  return connector;
};

const SERVER_STATE: WalletState = { kind: 'loading' };
const noopSubscribe = (): (() => void) => () => undefined;

/** The current DD 7.8 state. Server renders and the first client paint see `loading`. */
export const useWalletState = (): WalletState => {
  const instance = typeof window === 'undefined' ? undefined : getWalletConnector();
  return useSyncExternalStore(
    instance?.subscribe ?? noopSubscribe,
    instance?.getState ?? (() => SERVER_STATE),
    () => SERVER_STATE,
  );
};

/** The owner identity when the wallet passed both DD 7.8 checks, otherwise null. */
export const ownerOf = (state: WalletState): OwnerIdentity | null =>
  state.kind === 'connected' ? state.owner : null;

export const walletScanKey = (ownerPkhHex: string) =>
  ['atprice', 'wallet-scan', appNetwork.network, ownerPkhHex] as const;

/**
 * Balances from the browser's own Electrum scan (wallet.md "Balances"). Disabled until connected.
 * After a wallet action, invalidate `walletScanKey(owner.ownerPkhHex)` to rescan at once.
 */
export const walletScanQuery = (owner: OwnerIdentity | null) =>
  queryOptions<WalletScan>({
    queryKey: walletScanKey(owner?.ownerPkhHex ?? 'none'),
    queryFn: () => scanWallet(getChain(), getWalletConnector().pubkeyAt),
    enabled: owner !== null,
    refetchInterval: BALANCE_REFRESH_MS,
    staleTime: 5_000,
    retry: 1,
  });

export const useWalletScan = (owner: OwnerIdentity | null) => useQuery(walletScanQuery(owner));
