import type { ChainUtxo } from '@atprice/chain';
import { encodeLockingBytecodeP2pkh } from '@bitauth/libauth';
import { useCallback, useEffect, useState } from 'react';
import type { LoadedOrder } from '../core/lookup';
import type { RecoverChain } from '../core/server';

export type OwnerCoins =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly utxos: readonly ChainUtxo[]; readonly since: number }
  | { readonly kind: 'error'; readonly error: unknown };

/**
 * The coins at the owner address, from the user's server, kept current by an address subscription so a
 * top-up in the mempool rebuilds the cancel on its own (recover.md `NO_OWNER_UTXO`).
 */
export const useOwnerCoins = (
  chain: RecoverChain | null,
  order: LoadedOrder,
): { coins: OwnerCoins; checkAgain: () => void } => {
  const [coins, setCoins] = useState<OwnerCoins>({ kind: 'loading' });
  const active = order.status.kind === 'unspent';

  const load = useCallback(
    (isCurrent: () => boolean) => {
      if (chain === null) return;
      chain.getUtxos(encodeLockingBytecodeP2pkh(order.record.ownerPkh)).then(
        (utxos) => {
          if (isCurrent())
            setCoins((previous) => ({
              kind: 'ready',
              utxos,
              since: previous.kind === 'ready' ? previous.since : Date.now(),
            }));
        },
        (error: unknown) => {
          if (isCurrent()) setCoins({ kind: 'error', error });
        },
      );
    },
    [chain, order.record.ownerPkh],
  );

  useEffect(() => {
    if (chain === null || !active) return;
    let current = true;
    let unsubscribe: (() => Promise<void>) | undefined;
    chain
      .subscribeAddress(encodeLockingBytecodeP2pkh(order.record.ownerPkh), () => load(() => current))
      .then(
        (stop) => {
          if (current) unsubscribe = stop;
          else void stop();
        },
        (error: unknown) => {
          if (current) setCoins({ kind: 'error', error });
        },
      );
    return () => {
      current = false;
      void unsubscribe?.();
    };
  }, [chain, active, order.record.ownerPkh, load]);

  const checkAgain = useCallback(() => load(() => true), [load]);
  return { coins, checkAgain };
};
