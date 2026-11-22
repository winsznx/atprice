import { createBrowserChainClient, type ChainClient } from '@atprice/chain/browser';
import { appNetwork } from '../network';
import type { ChainAccess } from './types';

/**
 * The tab's one Electrum connection, `packages/chain`'s browser client (failover across the network's
 * browser servers, genesis check). It connects on first use; after a failed connect the next call
 * tries again from the top of the server list.
 */
class BrowserChain implements ChainAccess {
  private connecting: Promise<void> | undefined;

  constructor(private readonly client: ChainClient) {}

  get endpointLabel(): string | undefined {
    const endpoint = this.client.endpoint;
    return endpoint === undefined ? undefined : `${endpoint.host}:${endpoint.port}`;
  }

  private async ready(): Promise<ChainClient> {
    if (this.client.connected) return this.client;
    this.connecting ??= this.client.connect().finally(() => {
      this.connecting = undefined;
    });
    await this.connecting;
    return this.client;
  }

  getRawTransaction: ChainClient['getRawTransaction'] = async (txid) =>
    (await this.ready()).getRawTransaction(txid);
  getTransactionStatus: ChainClient['getTransactionStatus'] = async (txid) =>
    (await this.ready()).getTransactionStatus(txid);
  getUtxos: ChainClient['getUtxos'] = async (lockingBytecode) =>
    (await this.ready()).getUtxos(lockingBytecode);
  getHistory: ChainClient['getHistory'] = async (lockingBytecode) =>
    (await this.ready()).getHistory(lockingBytecode);
  getTip: ChainClient['getTip'] = async () => (await this.ready()).getTip();
  broadcast: ChainClient['broadcast'] = async (hex) => (await this.ready()).broadcast(hex);
  subscribeAddress: ChainClient['subscribeAddress'] = async (lockingBytecode, listener) =>
    (await this.ready()).subscribeAddress(lockingBytecode, listener);
}

let shared: ChainAccess | undefined;

/** Browser only: call it from effects, query functions or handlers, never during server render. */
export const getChain = (): ChainAccess => {
  if (typeof window === 'undefined') {
    throw new Error('getChain() runs in the browser only: Electrum is reached from the user’s own browser.');
  }
  shared ??= new BrowserChain(createBrowserChainClient(appNetwork.network, { application: 'AtPrice' }));
  return shared;
};
