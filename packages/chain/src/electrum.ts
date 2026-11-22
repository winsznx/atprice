import {
  ElectrumClient,
  type ElectrumClientEvents,
  type RPCNotification,
  type RPCParameter,
} from '@electrum-cash/network';
import type { ElectrumSocket } from '@electrum-cash/socket';
import type { Network } from '@atprice/core';
import { z } from 'zod';
import {
  ChainError,
  NoEndpointReachableError,
  BroadcastRejectedError,
  type EndpointFailure,
} from './errors.js';
import { CHAIN_NETWORKS, type ElectrumEndpoint } from './networks.js';
import { blockHashOfHeader, scripthashOf } from './scripthash.js';

/** Builds the transport for one endpoint; the Node and browser entry points each provide one. */
export type SocketFactory = (endpoint: ElectrumEndpoint) => ElectrumSocket;

export interface ChainToken {
  readonly category: string;
  readonly amount: bigint;
  readonly nft?: { readonly capability: 'none' | 'mutable' | 'minting'; readonly commitment: string };
}

export interface ChainUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: bigint;
  /** Block height, or 0 / -1 for a mempool transaction (Electrum convention). */
  readonly height: number;
  readonly token?: ChainToken;
}

export interface HistoryEntry {
  readonly txid: string;
  /** Block height, or 0 / -1 for a mempool transaction. */
  readonly height: number;
}

export interface ChainHeader {
  readonly height: number;
  readonly hex: string;
  readonly hash: string;
}

export interface TransactionStatus {
  readonly hex: string;
  /** 0 while in the mempool. */
  readonly confirmations: number;
  readonly blockHash: string | null;
}

export type ChainClientEvent =
  | {
      readonly kind: 'connected';
      readonly endpoint: ElectrumEndpoint;
      readonly software: string;
      readonly failover: boolean;
    }
  | { readonly kind: 'endpoint_failed'; readonly failure: EndpointFailure }
  | { readonly kind: 'disconnected'; readonly endpoint: ElectrumEndpoint }
  | {
      readonly kind: 'subscription_failed';
      readonly method: string;
      readonly params: string;
      readonly message: string;
    }
  | { readonly kind: 'notification_invalid'; readonly method: string; readonly message: string }
  | { readonly kind: 'hook_failed'; readonly message: string };

export interface ReconnectInfo {
  readonly endpoint: ElectrumEndpoint;
  /** True when the client moved to a different server. */
  readonly failover: boolean;
}

export type ReconnectHook = (info: ReconnectInfo) => Promise<void> | void;

export interface ChainClientOptions {
  readonly network: Network;
  readonly endpoints: readonly ElectrumEndpoint[];
  readonly socketFactory: SocketFactory;
  readonly application?: string;
  readonly requestTimeoutMs?: number;
  /** How long a lost connection may stay down before the client moves to the next server. */
  readonly failoverAfterMs?: number;
  /** Delay between full rounds over every endpoint while none is reachable. */
  readonly retryRoundDelayMs?: number;
  /** Delay before the library retries the same server after a drop. */
  readonly reconnectAfterMs?: number;
  readonly onEvent?: (event: ChainClientEvent) => void;
}

export type Unsubscribe = () => Promise<void>;

const PROTOCOL_VERSION = '1.5';
const HEX = /^[0-9a-f]*$/;
const TXID = z.string().regex(/^[0-9a-f]{64}$/);

const tokenSchema = z.object({
  category: TXID,
  amount: z.string().regex(/^\d+$/),
  nft: z
    .object({ capability: z.enum(['none', 'mutable', 'minting']), commitment: z.string().regex(HEX) })
    .optional(),
});

const utxoSchema = z.object({
  tx_hash: TXID,
  tx_pos: z.number().int().nonnegative(),
  height: z.number().int(),
  value: z.number().int().nonnegative(),
  token_data: tokenSchema.optional(),
});

const historySchema = z.array(z.object({ tx_hash: TXID, height: z.number().int() }));
const headerSchema = z.object({
  height: z.number().int().nonnegative(),
  hex: z.string().regex(/^[0-9a-f]{160}$/),
});
const featuresSchema = z.object({ genesis_hash: z.string() });
const verboseTxSchema = z.object({
  hex: z.string().regex(HEX),
  confirmations: z.number().int().nonnegative().optional(),
  blockhash: z.string().optional(),
});
const statusSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();

const parse = <T>(schema: z.ZodType<T>, value: unknown, method: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ChainError(
      'response_invalid',
      `${method} returned an unexpected shape: ${result.error.message}`,
    );
  }
  return result.data;
};

const toToken = (token: z.infer<typeof tokenSchema>): ChainToken => ({
  category: token.category,
  amount: BigInt(token.amount),
  ...(token.nft && { nft: { capability: token.nft.capability, commitment: token.nft.commitment } }),
});

const toHeader = (header: z.infer<typeof headerSchema>): ChainHeader => ({
  height: header.height,
  hex: header.hex,
  hash: blockHashOfHeader(header.hex),
});

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ADDRESS_METHOD = 'blockchain.scripthash.subscribe';
const HEADERS_METHOD = 'blockchain.headers.subscribe';

type Client = ElectrumClient<ElectrumClientEvents>;

interface Subscription {
  readonly method: string;
  readonly params: readonly string[];
  readonly listeners: Set<(value: unknown) => void>;
  restored: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Disconnects without letting a stuck library connect attempt (which holds the client's connection
 * lock) block the caller for longer than a second.
 */
const discard = async (client: Client): Promise<void> => {
  await Promise.race([client.disconnect(true, false).catch(() => false), delay(1_000)]);
};

/**
 * One logical Electrum connection with failover. Subscriptions are owned here, not by the library, so
 * that after every reconnect or failover the client knows exactly which ones were restored
 * (`subscriptionsHealthy`) and can then run the callers' backfill hooks.
 */
export class ChainClient {
  readonly network: Network;
  readonly genesisHash: string;
  private readonly endpoints: readonly ElectrumEndpoint[];
  private readonly socketFactory: SocketFactory;
  private readonly application: string;
  private readonly requestTimeoutMs: number;
  private readonly failoverAfterMs: number;
  private readonly retryRoundDelayMs: number;
  private readonly reconnectAfterMs: number;
  private readonly emitEvent: (event: ChainClientEvent) => void;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly reconnectHooks = new Set<ReconnectHook>();
  private client: Client | undefined;
  private endpointIndex = -1;
  private failoverTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private connectedNow = false;
  private recovering: Promise<void> | undefined;
  private lastHeader: ChainHeader | undefined;

  constructor(options: ChainClientOptions) {
    if (options.endpoints.length === 0)
      throw new ChainError('no_endpoint_reachable', 'no Electrum endpoints configured');
    this.network = options.network;
    this.genesisHash = CHAIN_NETWORKS[options.network].genesisHash;
    this.endpoints = options.endpoints;
    this.socketFactory = options.socketFactory;
    this.application = options.application ?? 'atprice';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.failoverAfterMs = options.failoverAfterMs ?? 15_000;
    this.retryRoundDelayMs = options.retryRoundDelayMs ?? 5_000;
    this.reconnectAfterMs = options.reconnectAfterMs ?? 5_000;
    this.emitEvent = options.onEvent ?? (() => undefined);
  }

  get endpoint(): ElectrumEndpoint | undefined {
    return this.endpoints[this.endpointIndex];
  }

  get connected(): boolean {
    return this.connectedNow;
  }

  /** True when connected and every registered subscription is active on the current connection. */
  get subscriptionsHealthy(): boolean {
    return (
      this.connectedNow && [...this.subscriptions.values()].every((subscription) => subscription.restored)
    );
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /** The most recent header seen through `subscribeHeaders`, if any. */
  get latestHeader(): ChainHeader | undefined {
    return this.lastHeader;
  }

  /** Connects to the first reachable endpoint whose genesis hash matches the network. */
  async connect(): Promise<void> {
    this.closed = false;
    await this.connectFrom(0, false, true);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearFailoverTimer();
    this.connectedNow = false;
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await discard(client);
  }

  /** Registers a hook that runs after every reconnect or failover, once subscriptions are restored. */
  onReconnect(hook: ReconnectHook): () => void {
    this.reconnectHooks.add(hook);
    return () => this.reconnectHooks.delete(hook);
  }

  async getRawTransaction(txid: string): Promise<string> {
    return parse(
      z.string().regex(HEX),
      await this.request('blockchain.transaction.get', txid, false),
      'transaction.get',
    );
  }

  async getTransactionStatus(txid: string): Promise<TransactionStatus> {
    const verbose = parse(
      verboseTxSchema,
      await this.request('blockchain.transaction.get', txid, true),
      'transaction.get',
    );
    return {
      hex: verbose.hex,
      confirmations: verbose.confirmations ?? 0,
      blockHash: verbose.blockhash ?? null,
    };
  }

  /** Unspent outputs of a locking bytecode, including token data (protocol 1.5 `include_tokens`). */
  async getUtxos(lockingBytecode: Uint8Array): Promise<ChainUtxo[]> {
    const rows = parse(
      z.array(utxoSchema),
      await this.request(
        'blockchain.scripthash.listunspent',
        scripthashOf(lockingBytecode),
        'include_tokens',
      ),
      'scripthash.listunspent',
    );
    return rows.map((row) => ({
      txid: row.tx_hash,
      vout: row.tx_pos,
      satoshis: BigInt(row.value),
      height: row.height,
      ...(row.token_data && { token: toToken(row.token_data) }),
    }));
  }

  async getHistory(lockingBytecode: Uint8Array): Promise<HistoryEntry[]> {
    const rows = parse(
      historySchema,
      await this.request('blockchain.scripthash.get_history', scripthashOf(lockingBytecode)),
      'scripthash.get_history',
    );
    return rows.map((row) => ({ txid: row.tx_hash, height: row.height }));
  }

  async getTip(): Promise<ChainHeader> {
    return toHeader(parse(headerSchema, await this.request('blockchain.headers.get_tip'), 'headers.get_tip'));
  }

  async getBlockHash(height: number): Promise<string> {
    const hex = parse(
      z.string().regex(/^[0-9a-f]{160}$/),
      await this.request('blockchain.block.header', height),
      'block.header',
    );
    return blockHashOfHeader(hex);
  }

  /** Broadcasts and returns the txid; a node rejection throws `BroadcastRejectedError` with the node's text. */
  async broadcast(hex: string): Promise<string> {
    const client = this.requireClient();
    const result = await this.withTimeout(
      client.request('blockchain.transaction.broadcast', hex),
      'transaction.broadcast',
    );
    if (result instanceof Error) throw new BroadcastRejectedError('electrum', result.message);
    return parse(TXID, result, 'transaction.broadcast');
  }

  /**
   * Subscribes to an address's status (a hash of its history, or null for an empty one). The listener
   * gets the current status immediately and again after every reconnect.
   */
  async subscribeAddress(
    lockingBytecode: Uint8Array,
    listener: (status: string | null) => void,
  ): Promise<Unsubscribe> {
    return this.subscribe(ADDRESS_METHOD, [scripthashOf(lockingBytecode)], (value) => {
      const status = statusSchema.safeParse(value);
      if (status.success) listener(status.data);
      else
        this.emitEvent({
          kind: 'notification_invalid',
          method: ADDRESS_METHOD,
          message: status.error.message,
        });
    });
  }

  async subscribeHeaders(listener: (header: ChainHeader) => void): Promise<Unsubscribe> {
    return this.subscribe(HEADERS_METHOD, [], (value) => {
      const header = headerSchema.safeParse(value);
      if (!header.success) {
        this.emitEvent({
          kind: 'notification_invalid',
          method: HEADERS_METHOD,
          message: header.error.message,
        });
        return;
      }
      const parsed = toHeader(header.data);
      this.lastHeader = parsed;
      listener(parsed);
    });
  }

  /** Retries subscriptions that failed to restore; returns true when all are active. */
  async retryFailedSubscriptions(): Promise<boolean> {
    if (!this.connectedNow) return false;
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.restored) await this.activate(subscription);
    }
    return this.subscriptionsHealthy;
  }

  private async subscribe(
    method: string,
    params: string[],
    listener: (value: unknown) => void,
  ): Promise<Unsubscribe> {
    const key = `${method}|${params.join(',')}`;
    let subscription = this.subscriptions.get(key);
    if (subscription === undefined) {
      subscription = { method, params, listeners: new Set(), restored: false };
      this.subscriptions.set(key, subscription);
      subscription.listeners.add(listener);
      try {
        const value = await this.request(method, ...params);
        subscription.restored = true;
        listener(value);
      } catch (error) {
        subscription.listeners.delete(listener);
        if (subscription.listeners.size === 0) this.subscriptions.delete(key);
        throw error;
      }
    } else {
      subscription.listeners.add(listener);
      if (subscription.restored) {
        listener(await this.request(method, ...params));
      }
    }
    const owned = subscription;
    return async () => {
      owned.listeners.delete(listener);
      if (owned.listeners.size > 0 || this.subscriptions.get(key) !== owned) return;
      this.subscriptions.delete(key);
      if (this.connectedNow && method !== HEADERS_METHOD) {
        await this.request(method.replace('.subscribe', '.unsubscribe'), ...params).catch(() => undefined);
      }
    };
  }

  private async activate(subscription: Subscription): Promise<void> {
    try {
      const value = await this.request(subscription.method, ...subscription.params);
      subscription.restored = true;
      for (const listener of subscription.listeners) listener(value);
    } catch (error) {
      subscription.restored = false;
      this.emitEvent({
        kind: 'subscription_failed',
        method: subscription.method,
        params: subscription.params.join(','),
        message: describe(error),
      });
    }
  }

  private async request(method: string, ...params: RPCParameter[]): Promise<unknown> {
    const client = this.requireClient();
    const result = await this.withTimeout(client.request(method, ...params), method);
    if (result instanceof Error)
      throw new ChainError('request_failed', `${method}: ${result.message}`, { cause: result });
    return result;
  }

  private requireClient(): Client {
    if (this.closed) throw new ChainError('closed', 'the chain client is closed');
    if (this.client === undefined || !this.connectedNow) {
      throw new ChainError('not_connected', 'not connected to an Electrum server');
    }
    return this.client;
  }

  private async withTimeout<T>(promise: Promise<T>, method: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new ChainError('request_timeout', `${method} timed out after ${this.requestTimeoutMs} ms`)),
        this.requestTimeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async openEndpoint(endpoint: ElectrumEndpoint): Promise<{ client: Client; software: string }> {
    const client: Client = new ElectrumClient(
      this.application,
      PROTOCOL_VERSION,
      this.socketFactory(endpoint),
      {
        timeoutInMilliSeconds: this.requestTimeoutMs,
        reconnectAfterMilliSeconds: this.reconnectAfterMs,
      },
    );
    // The library logs connection errors through this event; without a listener eventemitter3 drops them.
    client.on('error', () => undefined);
    try {
      await this.withTimeout(client.connect(), 'connect');
      const features = await this.withTimeout(client.request('server.features'), 'server.features');
      if (features instanceof Error)
        throw new ChainError('request_failed', `server.features: ${features.message}`);
      const { genesis_hash: genesis } = parse(featuresSchema, features, 'server.features');
      if (genesis !== this.genesisHash) {
        throw new ChainError(
          'genesis_mismatch',
          `genesis ${genesis} is not ${this.network} (${this.genesisHash})`,
        );
      }
      return { client, software: client.software };
    } catch (error) {
      await discard(client);
      throw error;
    }
  }

  /**
   * Tries every endpoint once, starting at `start`. `failFast` (the initial connect) throws when none
   * works; recovery keeps cycling until one answers or the client is closed.
   */
  private async connectFrom(start: number, failover: boolean, failFast: boolean): Promise<void> {
    for (;;) {
      const failures: EndpointFailure[] = [];
      for (let offset = 0; offset < this.endpoints.length; offset += 1) {
        if (this.closed) throw new ChainError('closed', 'the chain client is closed');
        const index = (start + offset) % this.endpoints.length;
        const endpoint = this.endpoints[index];
        if (endpoint === undefined) continue;
        try {
          const { client, software } = await this.openEndpoint(endpoint);
          this.adopt(client, index);
          this.emitEvent({ kind: 'connected', endpoint, software, failover });
          if (failover || this.subscriptions.size > 0) await this.afterReconnect({ endpoint, failover });
          return;
        } catch (error) {
          const failure: EndpointFailure = {
            endpoint,
            reason: error instanceof ChainError ? error.reason : 'request_failed',
            message: describe(error),
          };
          failures.push(failure);
          this.emitEvent({ kind: 'endpoint_failed', failure });
        }
      }
      if (failFast) throw new NoEndpointReachableError(failures);
      await delay(this.retryRoundDelayMs);
    }
  }

  private adopt(client: Client, index: number): void {
    this.client = client;
    this.endpointIndex = index;
    this.connectedNow = true;
    for (const subscription of this.subscriptions.values()) subscription.restored = false;
    client.on('notification', (notification: RPCNotification) => this.dispatch(notification));
    client.on('disconnected', () => this.handleDisconnect(client));
    client.on('connected', () => this.handleLibraryReconnect(client));
  }

  private dispatch(notification: RPCNotification): void {
    const params = notification.params ?? [];
    if (notification.method === HEADERS_METHOD) {
      const subscription = this.subscriptions.get(`${HEADERS_METHOD}|`);
      for (const listener of subscription?.listeners ?? []) listener(params[0]);
      return;
    }
    if (notification.method === ADDRESS_METHOD) {
      const [scripthash, status] = params;
      const subscription = this.subscriptions.get(`${ADDRESS_METHOD}|${String(scripthash)}`);
      for (const listener of subscription?.listeners ?? []) listener(status);
    }
  }

  private handleDisconnect(client: Client): void {
    if (client !== this.client || this.closed) return;
    this.connectedNow = false;
    for (const subscription of this.subscriptions.values()) subscription.restored = false;
    const endpoint = this.endpoint;
    if (endpoint !== undefined) this.emitEvent({ kind: 'disconnected', endpoint });
    this.clearFailoverTimer();
    this.failoverTimer = setTimeout(() => {
      this.failoverTimer = undefined;
      void this.failover(client);
    }, this.failoverAfterMs);
  }

  /** The library reconnected to the same server on its own: re-check genesis, restore, backfill. */
  private handleLibraryReconnect(client: Client): void {
    if (client !== this.client || this.closed || this.connectedNow) return;
    this.clearFailoverTimer();
    this.recovering = (async () => {
      const features = await this.withTimeout(client.request('server.features'), 'server.features').catch(
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      const genesis =
        features instanceof Error ? undefined : featuresSchema.safeParse(features).data?.genesis_hash;
      if (genesis !== this.genesisHash) {
        await this.failover(client);
        return;
      }
      this.connectedNow = true;
      const endpoint = this.endpoint;
      if (endpoint === undefined) return;
      this.emitEvent({ kind: 'connected', endpoint, software: client.software, failover: false });
      await this.afterReconnect({ endpoint, failover: false });
    })().finally(() => {
      this.recovering = undefined;
    });
  }

  private async failover(from: Client): Promise<void> {
    if (from !== this.client || this.closed) return;
    this.connectedNow = false;
    this.client = undefined;
    await discard(from);
    await this.connectFrom(this.endpointIndex + 1, true, false).catch((error: unknown) => {
      if (!(error instanceof ChainError && error.reason === 'closed')) {
        this.emitEvent({ kind: 'hook_failed', message: describe(error) });
      }
    });
  }

  private async afterReconnect(info: ReconnectInfo): Promise<void> {
    for (const subscription of this.subscriptions.values()) await this.activate(subscription);
    for (const hook of this.reconnectHooks) {
      try {
        await hook(info);
      } catch (error) {
        this.emitEvent({ kind: 'hook_failed', message: describe(error) });
      }
    }
  }

  private clearFailoverTimer(): void {
    if (this.failoverTimer !== undefined) clearTimeout(this.failoverTimer);
    this.failoverTimer = undefined;
  }

  /** Resolves once an in-progress same-server recovery has finished (tests and orderly shutdown). */
  async settled(): Promise<void> {
    await this.recovering;
  }
}
