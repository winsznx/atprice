import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import type { ElectrumSocket } from '@electrum-cash/socket';
import type { Network } from '@atprice/core';
import { ChainClient, type ChainClientOptions } from './electrum.js';
import { CHAIN_NETWORKS, type ElectrumEndpoint, type RostrumEndpoint } from './networks.js';
import { RostrumPoolClient, type RostrumClientOptions } from './rostrum.js';

export * from './index.js';

/**
 * Browser transport. `enforceConsistentBrowserBehavior: false` keeps the socket open while the tab is
 * hidden, so an order's status keeps updating in a background tab; in a browser TLS is verified by the
 * browser itself regardless of this flag.
 */
export const browserSocketFactory = (endpoint: ElectrumEndpoint | RostrumEndpoint): ElectrumSocket =>
  new ElectrumWebSocket(endpoint.host, {
    port: endpoint.port,
    encrypted: true,
    enforceConsistentBrowserBehavior: false,
  });

export const createBrowserChainClient = (
  network: Network,
  options: Partial<Omit<ChainClientOptions, 'network' | 'socketFactory'>> = {},
): ChainClient =>
  new ChainClient({
    endpoints: CHAIN_NETWORKS[network].browserElectrum,
    ...options,
    network,
    socketFactory: browserSocketFactory,
  });

export const createBrowserRostrumClient = (
  network: Network,
  options: Partial<Omit<RostrumClientOptions, 'network' | 'socketFactory'>> = {},
): RostrumPoolClient => new RostrumPoolClient({ ...options, network, socketFactory: browserSocketFactory });
