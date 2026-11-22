import { CHAIN_NETWORKS, explorerLinks, type ElectrumEndpoint, type ExplorerLinks } from '@atprice/chain';
import type { Network } from '@atprice/core';

/**
 * What one Recover build is for. The browser file gets it from the build (one file per network,
 * recover.md "Shell"); the CLI builds it from its flags. Nothing here is read from an AtPrice server.
 */
export interface RecoverConfig {
  readonly network: Network;
  readonly version: string;
  /** Absolute `https://` URL of the AtPrice website, or null when the build leaves it empty. */
  readonly websiteUrl: string | null;
  /** Absolute `https://` URL of the source code, or null when the build leaves it empty. */
  readonly sourceUrl: string | null;
}

/** Header label (recover.md "Shell", DD 7.15 network badge). */
export const NETWORK_BADGE: Readonly<Record<Network, string>> = {
  mainnet: 'Mainnet',
  chipnet: 'Chipnet: test coins',
};

export const CASH_ADDRESS_PREFIX: Readonly<Record<Network, 'bitcoincash' | 'bchtest'>> = {
  mainnet: 'bitcoincash',
  chipnet: 'bchtest',
};

/** libauth `decodeHdPublicKey(...).network` of a wallet on this network: a chipnet wallet sends a `tpub`. */
export const XPUB_NETWORK: Readonly<Record<Network, 'mainnet' | 'testnet'>> = {
  mainnet: 'mainnet',
  chipnet: 'testnet',
};

/**
 * WizardConnect's public Nostr relays, in the library's default order so the pairing URI carries no
 * relay host and the QR stays short (research/wizardconnect.md section 3). They are part of the wallet
 * protocol, not AtPrice hosts.
 */
export const WIZARDCONNECT_RELAYS: readonly string[] = [
  'wss://relay.riften.net:443',
  'wss://relay.cauldron.quest:443',
];

/** The browser (WebSocket) servers bundled for `network`, from `packages/chain`. */
export const bundledServers = (network: Network): readonly ElectrumEndpoint[] =>
  CHAIN_NETWORKS[network].browserElectrum;

export const genesisHashOf = (network: Network): string => CHAIN_NETWORKS[network].genesisHash;

export const explorerFor = (network: Network): ExplorerLinks => explorerLinks(network);

/** DD 7.12: a chipnet link never reads like a mainnet one. */
export const explorerLabel = (network: Network): string =>
  network === 'mainnet' ? 'explorer' : 'chipnet explorer';

export const endpointHost = (endpoint: ElectrumEndpoint): string =>
  endpoint.port === 443 ? endpoint.host : `${endpoint.host}:${endpoint.port}`;
