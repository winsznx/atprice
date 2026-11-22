import { ElectrumTcpSocket } from '@electrum-cash/tcp-socket';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import type { ElectrumSocket } from '@electrum-cash/socket';
import type { Network } from '@atprice/core';
import { ChainClient, type ChainClientOptions } from './electrum.js';
import { CHAIN_NETWORKS, type ElectrumEndpoint, type RostrumEndpoint } from './networks.js';
import { RostrumPoolClient, type RostrumClientOptions } from './rostrum.js';

export * from './index.js';

/**
 * Node transport. TLS certificates are always verified: `enforceConsistentBrowserBehavior` doubles as
 * `rejectUnauthorized` for WebSockets outside a browser, so it must stay true here.
 */
export const nodeSocketFactory = (endpoint: ElectrumEndpoint | RostrumEndpoint): ElectrumSocket => {
  if ('transport' in endpoint && endpoint.transport === 'tls') {
    return new ElectrumTcpSocket(endpoint.host, {
      port: endpoint.port,
      encrypted: true,
      rejectUnauthorized: true,
    });
  }
  return new ElectrumWebSocket(endpoint.host, {
    port: endpoint.port,
    encrypted: true,
    enforceConsistentBrowserBehavior: true,
  });
};

export const createNodeChainClient = (
  network: Network,
  options: Partial<Omit<ChainClientOptions, 'network' | 'socketFactory'>> = {},
): ChainClient =>
  new ChainClient({
    endpoints: CHAIN_NETWORKS[network].nodeElectrum,
    ...options,
    network,
    socketFactory: nodeSocketFactory,
  });

export const createNodeRostrumClient = (
  network: Network,
  options: Partial<Omit<RostrumClientOptions, 'network' | 'socketFactory'>> = {},
): RostrumPoolClient => new RostrumPoolClient({ ...options, network, socketFactory: nodeSocketFactory });
