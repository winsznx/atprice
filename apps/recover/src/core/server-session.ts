import type { ChainClientEvent, ElectrumEndpoint } from '@atprice/chain';
import type { Network } from '@atprice/core';
import { endpointHost } from '../config';
import { RecoverError } from './errors';
import { connectServer, type ChainFactory, type RecoverChain } from './server';

export type ServerState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting'; readonly host: string; readonly endpoint: ElectrumEndpoint }
  | {
      readonly kind: 'connected';
      readonly host: string;
      readonly endpoint: ElectrumEndpoint;
      readonly chain: RecoverChain;
      readonly tip: number;
      /** The socket dropped; `packages/chain` is reconnecting to the same server. */
      readonly lost: boolean;
    }
  | {
      readonly kind: 'error';
      readonly host: string;
      readonly endpoint: ElectrumEndpoint;
      readonly error: RecoverError;
    };

/**
 * The one server connection of the page: the user picks it, sees it, and can change it at any time
 * (recover.md hard rule 2). A store, so React reads it with `useSyncExternalStore`.
 */
export class ServerSession {
  private state: ServerState = { kind: 'idle' };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private stopHeaders: (() => Promise<void>) | undefined;

  constructor(
    private readonly network: Network,
    private readonly factory: ChainFactory,
  ) {}

  getState = (): ServerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(next: ServerState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private onEvent(generation: number, event: ChainClientEvent): void {
    if (generation !== this.generation || this.state.kind !== 'connected') return;
    if (event.kind === 'disconnected') this.setState({ ...this.state, lost: true });
    if (event.kind === 'connected') this.setState({ ...this.state, lost: false });
  }

  /** Connects to `endpoint`, closing any previous server first. Resolves true when connected. */
  async connect(endpoint: ElectrumEndpoint): Promise<boolean> {
    const generation = ++this.generation;
    await this.release();
    const host = endpointHost(endpoint);
    this.setState({ kind: 'connecting', host, endpoint });
    try {
      const connected = await connectServer({
        network: this.network,
        endpoint,
        factory: this.factory,
        onEvent: (event) => this.onEvent(generation, event),
      });
      if (generation !== this.generation) {
        await connected.chain.close();
        return false;
      }
      this.setState({
        kind: 'connected',
        host,
        endpoint,
        chain: connected.chain,
        tip: connected.tip.height,
        lost: false,
      });
      this.stopHeaders = await connected.chain
        .subscribeHeaders((header) => {
          if (
            generation === this.generation &&
            this.state.kind === 'connected' &&
            header.height !== this.state.tip
          ) {
            this.setState({ ...this.state, tip: header.height });
          }
        })
        .catch((error: unknown) => {
          console.error('Header subscription failed; the tip shown stays at the connect height:', error);
          return undefined;
        });
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const failure =
        error instanceof RecoverError
          ? error
          : new RecoverError(
              'ELECTRUM_UNREACHABLE',
              `Couldn't reach ${host} (ELECTRUM_UNREACHABLE). Pick another server.`,
            );
      this.setState({ kind: 'error', host, endpoint, error: failure });
      return false;
    }
  }

  private async release(): Promise<void> {
    const previous = this.state;
    const stop = this.stopHeaders;
    this.stopHeaders = undefined;
    if (stop !== undefined)
      await stop().catch((error: unknown) => console.error('Header unsubscribe failed:', error));
    if (previous.kind === 'connected') await previous.chain.close();
  }

  async close(): Promise<void> {
    this.generation += 1;
    await this.release();
    this.setState({ kind: 'idle' });
  }
}
