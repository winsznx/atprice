import { CHAIN_NETWORKS, explorerLinks } from '@atprice/chain';
import type { Network } from '@atprice/core';
import { publicEnv } from './env/public';

export interface ExplorerConfig {
  /** Shown in accessible names and labels, so a chipnet link never reads like a mainnet one (DD 7.12). */
  readonly label: string;
  readonly tx: (txid: string) => string;
  readonly address: (address: string) => string;
  /** Null where no token explorer with a verified URL pattern exists for the network (DOCS_INDEX section 9). */
  readonly token: ((category: string) => string) | null;
}

export interface NetworkConfig {
  readonly network: Network;
  /** Display name used in copy: `mainnet` or `chipnet`. */
  readonly name: string;
  readonly cashAddressPrefix: 'bitcoincash' | 'bchtest';
  /** libauth `decodeHdPublicKey(...).network` a wallet on this network reports (`tpub` decodes as testnet). */
  readonly xpubNetwork: 'mainnet' | 'testnet';
  readonly genesisHash: string;
  readonly explorer: ExplorerConfig;
  /** Average block interval: chipnet has run 1-minute blocks since 2026-11-15 (D-007). */
  readonly blockIntervalMinutes: number;
  readonly faucet: { readonly url: string; readonly label: string } | null;
  /** Nostr relays for WizardConnect pairing, in the library's default order so the QR stays short. */
  readonly wizardConnectRelays: readonly string[];
}

const WIZARDCONNECT_RELAYS = ['wss://relay.riften.net:443', 'wss://relay.cauldron.quest:443'] as const;

const MAINNET: NetworkConfig = {
  network: 'mainnet',
  name: 'mainnet',
  cashAddressPrefix: 'bitcoincash',
  xpubNetwork: 'mainnet',
  genesisHash: CHAIN_NETWORKS.mainnet.genesisHash,
  explorer: {
    label: 'explorer',
    tx: explorerLinks('mainnet').transaction,
    address: explorerLinks('mainnet').address,
    token: (category) => `https://tokenexplorer.cash/?tokenId=${category}`,
  },
  blockIntervalMinutes: 10,
  faucet: null,
  wizardConnectRelays: WIZARDCONNECT_RELAYS,
};

const CHIPNET: NetworkConfig = {
  network: 'chipnet',
  name: 'chipnet',
  cashAddressPrefix: 'bchtest',
  xpubNetwork: 'testnet',
  genesisHash: CHAIN_NETWORKS.chipnet.genesisHash,
  explorer: {
    label: 'chipnet explorer',
    tx: explorerLinks('chipnet').transaction,
    address: explorerLinks('chipnet').address,
    token: null,
  },
  blockIntervalMinutes: 1,
  faucet: { url: 'https://faucet.paytaca.com/', label: 'Paytaca chipnet faucet (asks for a passcode)' },
  wizardConnectRelays: WIZARDCONNECT_RELAYS,
};

export const networkConfigFor = (network: Network): NetworkConfig =>
  network === 'mainnet' ? MAINNET : CHIPNET;

/** The network this build serves (`NEXT_PUBLIC_ATPRICE_NETWORK`). */
export const appNetwork: NetworkConfig = networkConfigFor(publicEnv.network);

/** Every WSS origin the browser may open, for the Content-Security-Policy `connect-src`. */
export const browserSocketOrigins = (config: NetworkConfig): string[] => [
  ...CHAIN_NETWORKS[config.network].browserElectrum.map(({ host, port }) => `wss://${host}:${port}`),
  ...config.wizardConnectRelays,
];
