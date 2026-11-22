import type { Network } from '@atprice/core';

export interface ExplorerLinks {
  readonly transaction: (txid: string) => string;
  readonly address: (cashAddress: string) => string;
}

/**
 * Explorer deep links verified in DOCS_INDEX section 9: chipnet.imaginary.cash for chipnet and
 * explorer.selene.cash for mainnet (explorer.bitcoin.com loses the deep link).
 */
export const EXPLORERS: Readonly<Record<Network, ExplorerLinks>> = {
  chipnet: {
    transaction: (txid) => `https://chipnet.imaginary.cash/tx/${txid}`,
    address: (address) => `https://chipnet.imaginary.cash/address/${address}`,
  },
  mainnet: {
    transaction: (txid) => `https://explorer.selene.cash/tx/${txid}?network=mainnet`,
    address: (address) => `https://explorer.selene.cash/address/${address}?network=mainnet`,
  },
};

export const explorerLinks = (network: Network): ExplorerLinks => EXPLORERS[network];
