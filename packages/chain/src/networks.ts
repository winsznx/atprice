import type { Network } from '@atprice/core';

/** One Electrum server reachable over a given transport. */
export interface ElectrumEndpoint {
  readonly host: string;
  readonly port: number;
  /** `tls` is a raw TLS socket (Node), `wss` a secure WebSocket (browser, and Rostrum from Node). */
  readonly transport: 'tls' | 'wss';
}

export interface RostrumEndpoint {
  readonly host: string;
  readonly port: number;
}

export interface ChainNetworkConfig {
  readonly network: Network;
  readonly genesisHash: string;
  readonly cashAddressPrefix: 'bitcoincash' | 'bchtest';
  /** Node (keeper, API) servers in priority order: primary first, then failover. */
  readonly nodeElectrum: readonly ElectrumEndpoint[];
  /** Browser servers in priority order. */
  readonly browserElectrum: readonly ElectrumEndpoint[];
  readonly cauldronIndexerUrl: string;
  readonly rostrum: RostrumEndpoint;
  /** Riften's broadcast endpoint; none is documented for chipnet (DOCS_INDEX section 7). */
  readonly cauldronBroadcastUrl: string | null;
  /** Expected block interval, for the displayed confirmation wait only (D-007). */
  readonly blockIntervalSeconds: number;
}

const tls = (host: string, port = 50002): ElectrumEndpoint => ({ host, port, transport: 'tls' });
const wss = (host: string, port = 50004): ElectrumEndpoint => ({ host, port, transport: 'wss' });

/**
 * Servers and endpoints from DOCS_INDEX.md sections 7 and 8 (probed 2026-11-22). `cbch.loping.net`
 * is left out on purpose: it answers every RPC while thousands of blocks behind.
 */
export const CHAIN_NETWORKS: Readonly<Record<Network, ChainNetworkConfig>> = {
  chipnet: {
    network: 'chipnet',
    genesisHash: '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b',
    cashAddressPrefix: 'bchtest',
    nodeElectrum: [
      tls('chipnet.imaginary.cash'),
      tls('chipnet.bch.ninja'),
      tls('chipnet.c3-soft.com', 64002),
      tls('blackie.c3-soft.com', 64002),
    ],
    browserElectrum: [
      wss('chipnet.imaginary.cash'),
      wss('chipnet.bch.ninja'),
      wss('chipnet.c3-soft.com', 64004),
      wss('blackie.c3-soft.com', 64004),
    ],
    cauldronIndexerUrl: 'https://indexer-chipnet.riften.net',
    rostrum: { host: 'rostrum-chipnet.riften.net', port: 443 },
    cauldronBroadcastUrl: null,
    blockIntervalSeconds: 60,
  },
  mainnet: {
    network: 'mainnet',
    genesisHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    cashAddressPrefix: 'bitcoincash',
    nodeElectrum: [
      tls('bch.imaginary.cash'),
      tls('bch.loping.net'),
      tls('cashnode.bch.ninja'),
      tls('bch.cyberbits.eu'),
    ],
    browserElectrum: [
      wss('bch.imaginary.cash'),
      wss('electrum.imaginary.cash'),
      wss('bch.loping.net'),
      wss('cashnode.bch.ninja'),
      wss('fulcrum.greyh.at'),
      wss('blackie.c3-soft.com'),
    ],
    cauldronIndexerUrl: 'https://indexer.riften.net',
    rostrum: { host: 'rostrum.riften.net', port: 443 },
    cauldronBroadcastUrl: 'https://broadcast.cauldron.quest/broadcast',
    blockIntervalSeconds: 600,
  },
};

export class ElectrumEndpointParseError extends Error {
  readonly reason = 'electrum_endpoint_invalid';
  constructor(readonly entry: string) {
    super(`Electrum server "${entry}" is not host:port`);
    this.name = 'ElectrumEndpointParseError';
  }
}

const HOST_PATTERN = /^[a-z0-9.-]+$/i;

/** Parses a comma-separated `host:port` list (the server's Electrum override variable). */
export const parseElectrumEndpoints = (
  value: string,
  transport: ElectrumEndpoint['transport'],
): ElectrumEndpoint[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.lastIndexOf(':');
      const host = entry.slice(0, separator);
      const port = Number(entry.slice(separator + 1));
      if (
        separator <= 0 ||
        !HOST_PATTERN.test(host) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535
      ) {
        throw new ElectrumEndpointParseError(entry);
      }
      return { host, port, transport };
    });
