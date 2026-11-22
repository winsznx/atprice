import type { Network } from '@atprice/core';
import { explorerFor, explorerLabel } from '../config';
import type { ExplorerTarget } from './primitives';

/** DD 7.12 explorer link for a transaction (an outpoint opens its transaction). */
export const txExplorer = (network: Network, txid: string): ExplorerTarget => ({
  href: explorerFor(network).transaction(txid),
  label: `Open transaction in ${explorerLabel(network)}, opens in a new tab`,
});

export const addressExplorer = (network: Network, address: string): ExplorerTarget => ({
  href: explorerFor(network).address(address),
  label: `Open address in ${explorerLabel(network)}, opens in a new tab`,
});
