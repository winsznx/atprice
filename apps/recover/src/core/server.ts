import {
  ChainError,
  NoEndpointReachableError,
  type ChainClient,
  type ChainClientEvent,
  type ChainHeader,
  type ElectrumEndpoint,
} from '@atprice/chain';
import type { Network } from '@atprice/core';
import { endpointHost } from '../config';
import { describeError, RecoverError } from './errors';

/** The Electrum calls Recover makes. Typed as a subset so tests can pass a fake server. */
export type RecoverChain = Pick<
  ChainClient,
  | 'getRawTransaction'
  | 'getUtxos'
  | 'getHistory'
  | 'getTip'
  | 'broadcast'
  | 'subscribeAddress'
  | 'subscribeHeaders'
  | 'close'
  | 'connect'
>;

/** Builds a client for one endpoint: the browser passes WebSockets, the CLI TLS or WebSockets. */
export type ChainFactory = (
  network: Network,
  endpoint: ElectrumEndpoint,
  onEvent: (event: ChainClientEvent) => void,
) => RecoverChain;

export interface ConnectedServer {
  readonly chain: RecoverChain;
  readonly endpoint: ElectrumEndpoint;
  readonly host: string;
  readonly tip: ChainHeader;
}

/** recover.md "States": connecting times out after 10 s with the unreachable error. */
export const CONNECT_TIMEOUT_MS = 10_000;

const OTHER_NETWORK: Readonly<Record<Network, Network>> = { mainnet: 'chipnet', chipnet: 'mainnet' };

const withTimeout = async <T>(promise: Promise<T>, ms: number, host: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ChainError('request_timeout', `${host} did not answer within ${ms / 1000} s`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const isGenesisMismatch = (error: unknown): boolean =>
  error instanceof NoEndpointReachableError &&
  error.failures.some((failure) => failure.reason === 'genesis_mismatch');

/**
 * `packages/chain` reports a genesis mismatch without naming the network it found, so the server is
 * asked once more as the other network: a successful connect names it, anything else stays unnamed.
 */
const identifyOtherNetwork = async (
  network: Network,
  endpoint: ElectrumEndpoint,
  factory: ChainFactory,
): Promise<Network | null> => {
  const other = OTHER_NETWORK[network];
  const probe = factory(other, endpoint, () => undefined);
  try {
    await withTimeout(probe.connect(), CONNECT_TIMEOUT_MS, endpoint.host);
    return other;
  } catch {
    return null;
  } finally {
    await probe.close();
  }
};

export const wrongNetworkMessage = (host: string, found: Network | null, network: Network): string =>
  found === null
    ? `${host} is not a ${network} server. This file recovers ${network} orders.`
    : `${host} is a ${found} server. This file recovers ${network} orders.`;

export const unreachableMessage = (host: string): string =>
  `Couldn't reach ${host} (ELECTRUM_UNREACHABLE). Pick another server.`;

/**
 * Connects to one user-visible server and checks its genesis hash against the file's network (the
 * check lives in `packages/chain`). Throws a `RecoverError` with the recover.md copy on failure.
 */
export const connectServer = async (options: {
  readonly network: Network;
  readonly endpoint: ElectrumEndpoint;
  readonly factory: ChainFactory;
  readonly onEvent: (event: ChainClientEvent) => void;
}): Promise<ConnectedServer> => {
  const { network, endpoint, factory } = options;
  const host = endpointHost(endpoint);
  const chain = factory(network, endpoint, options.onEvent);
  try {
    await withTimeout(chain.connect(), CONNECT_TIMEOUT_MS, host);
    const tip = await withTimeout(chain.getTip(), CONNECT_TIMEOUT_MS, host);
    return { chain, endpoint, host, tip };
  } catch (error) {
    await chain.close();
    if (isGenesisMismatch(error)) {
      const found = await identifyOtherNetwork(network, endpoint, factory);
      throw new RecoverError('ELECTRUM_WRONG_NETWORK', wrongNetworkMessage(host, found, network), {
        cause: error,
      });
    }
    throw new RecoverError('ELECTRUM_UNREACHABLE', unreachableMessage(host), {
      cause: new Error(describeError(error)),
    });
  }
};
