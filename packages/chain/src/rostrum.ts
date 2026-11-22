import { ElectrumClient, type ElectrumClientEvents, type RPCNotification } from '@electrum-cash/network';
import type { ElectrumSocket } from '@electrum-cash/socket';
import type { Network } from '@atprice/core';
import { z } from 'zod';
import { ChainError } from './errors.js';
import { CHAIN_NETWORKS, type RostrumEndpoint } from './networks.js';

/** One live Cauldron pool UTXO as Rostrum reports it. Amounts are nominations: re-read before spending. */
export interface RostrumPool {
  readonly utxoHash: string;
  readonly txid: string;
  readonly vout: number;
  readonly ownerPkh: string;
  readonly tokenId: string;
  readonly sats: bigint;
  readonly tokens: bigint;
}

export type RostrumEvent =
  | { readonly kind: 'connected'; readonly software: string }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'subscription_failed'; readonly tokenId: string; readonly message: string }
  | { readonly kind: 'notification_invalid'; readonly message: string };

export interface RostrumClientOptions {
  readonly network: Network;
  readonly endpoint?: RostrumEndpoint;
  readonly socketFactory: (endpoint: RostrumEndpoint) => ElectrumSocket;
  readonly requestTimeoutMs?: number;
  readonly onEvent?: (event: RostrumEvent) => void;
}

/** Rostrum speaks Electrum protocol 1.4.3 at most (DOCS_INDEX section 3). */
const ROSTRUM_PROTOCOL = '1.4.3';
/** `cauldron.contract.subscribe` only supports contract version 2 (Cauldron PoolV0). */
const CONTRACT_VERSION = 2;
const METHOD = 'cauldron.contract.subscribe';
const ZERO_HASH = '0'.repeat(64);

const amount = z.union([z.bigint(), z.number().int()]).transform((value) => BigInt(value));
const index = z.union([z.bigint(), z.number().int()]).transform((value) => Number(value));

const utxoSchema = z.object({
  is_withdrawn: z.boolean(),
  new_utxo_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  new_utxo_n: index.optional(),
  new_utxo_txid: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  pkh: z.string().regex(/^[0-9a-f]{40}$/),
  sats: amount,
  spent_utxo_hash: z.string().regex(/^[0-9a-f]{64}$/),
  token_amount: amount,
  token_id: z.string().regex(/^[0-9a-f]{64}$/),
});

const payloadSchema = z.object({ type: z.enum(['initial', 'update']), utxos: z.array(utxoSchema) });

type PoolListener = (tokenId: string, pools: readonly RostrumPool[]) => void;

/**
 * `cauldron.contract.subscribe` per token on a Rostrum server, keeping the current pool set per token.
 * New UTXOs are applied before spent ones are removed, as the Riften docs require, because the server
 * does not order a chain of trades within one update.
 */
export class RostrumPoolClient {
  private readonly endpoint: RostrumEndpoint;
  private readonly genesisHash: string;
  private readonly socketFactory: (endpoint: RostrumEndpoint) => ElectrumSocket;
  private readonly requestTimeoutMs: number;
  private readonly emitEvent: (event: RostrumEvent) => void;
  private readonly pools = new Map<string, Map<string, RostrumPool>>();
  private readonly listeners = new Set<PoolListener>();
  private readonly lastUpdate = new Map<string, number>();
  private client: ElectrumClient<ElectrumClientEvents> | undefined;
  private connectedNow = false;

  constructor(options: RostrumClientOptions) {
    this.endpoint = options.endpoint ?? CHAIN_NETWORKS[options.network].rostrum;
    this.genesisHash = CHAIN_NETWORKS[options.network].genesisHash;
    this.socketFactory = options.socketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.emitEvent = options.onEvent ?? (() => undefined);
  }

  get connected(): boolean {
    return this.connectedNow;
  }

  /** Wall-clock time of the last initial or update payload for a token. */
  lastUpdateAt(tokenId: string): number | undefined {
    return this.lastUpdate.get(tokenId);
  }

  poolsOf(tokenId: string): readonly RostrumPool[] {
    return [...(this.pools.get(tokenId)?.values() ?? [])];
  }

  onChange(listener: PoolListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    const client = new ElectrumClient<ElectrumClientEvents>(
      'atprice',
      ROSTRUM_PROTOCOL,
      this.socketFactory(this.endpoint),
      {
        timeoutInMilliSeconds: this.requestTimeoutMs,
        useBigInt: true,
      },
    );
    client.on('error', () => undefined);
    client.on('notification', (notification: RPCNotification) => this.handleNotification(notification));
    client.on('disconnected', () => {
      this.connectedNow = false;
      this.emitEvent({ kind: 'disconnected' });
    });
    client.on('connected', () => {
      if (this.connectedNow || this.client !== client) return;
      void this.resubscribeAll();
    });
    await client.connect();
    const features = await client.request('server.features');
    const genesis =
      features instanceof Error ? undefined : z.object({ genesis_hash: z.string() }).safeParse(features).data;
    if (genesis?.genesis_hash !== this.genesisHash) {
      await client.disconnect(true, false).catch(() => false);
      throw new ChainError(
        'genesis_mismatch',
        `Rostrum ${this.endpoint.host} is not on the expected network`,
      );
    }
    this.client = client;
    this.connectedNow = true;
    this.emitEvent({ kind: 'connected', software: client.software });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connectedNow = false;
    if (client !== undefined) await client.disconnect(true, false).catch(() => false);
  }

  /** Subscribes to a token's pools and returns the initial set. */
  async subscribe(tokenId: string): Promise<readonly RostrumPool[]> {
    if (!this.pools.has(tokenId)) this.pools.set(tokenId, new Map());
    const client = this.client;
    if (client === undefined || !this.connectedNow)
      throw new ChainError('not_connected', 'Rostrum is not connected');
    const result = await client.request(METHOD, CONTRACT_VERSION, tokenId);
    if (result instanceof Error) {
      this.emitEvent({ kind: 'subscription_failed', tokenId, message: result.message });
      throw new ChainError('request_failed', `${METHOD} ${tokenId}: ${result.message}`);
    }
    this.apply(tokenId, result, true);
    return this.poolsOf(tokenId);
  }

  private async resubscribeAll(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    this.connectedNow = true;
    this.emitEvent({ kind: 'connected', software: client.software });
    for (const tokenId of this.pools.keys()) {
      await this.subscribe(tokenId).catch(() => undefined);
    }
  }

  private handleNotification(notification: RPCNotification): void {
    if (notification.method !== METHOD) return;
    const raw: unknown = notification.params;
    const payload = Array.isArray(raw) ? raw.at(-1) : raw;
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      this.emitEvent({ kind: 'notification_invalid', message: parsed.error.message });
      return;
    }
    const tokens = new Set(parsed.data.utxos.map((utxo) => utxo.token_id));
    for (const tokenId of tokens) {
      if (this.pools.has(tokenId)) this.apply(tokenId, payload, false);
    }
  }

  private apply(tokenId: string, payload: unknown, initial: boolean): void {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      this.emitEvent({ kind: 'notification_invalid', message: parsed.error.message });
      return;
    }
    const current = initial ? new Map<string, RostrumPool>() : new Map(this.pools.get(tokenId) ?? []);
    const utxos = parsed.data.utxos.filter((utxo) => utxo.token_id === tokenId);
    for (const utxo of utxos) {
      if (utxo.is_withdrawn || utxo.new_utxo_hash === undefined || utxo.new_utxo_txid === undefined) continue;
      if (utxo.new_utxo_n === undefined) continue;
      current.set(utxo.new_utxo_hash, {
        utxoHash: utxo.new_utxo_hash,
        txid: utxo.new_utxo_txid,
        vout: utxo.new_utxo_n,
        ownerPkh: utxo.pkh,
        tokenId,
        sats: utxo.sats,
        tokens: utxo.token_amount,
      });
    }
    for (const utxo of utxos) {
      if (utxo.spent_utxo_hash !== ZERO_HASH) current.delete(utxo.spent_utxo_hash);
    }
    this.pools.set(tokenId, current);
    this.lastUpdate.set(tokenId, Date.now());
    const snapshot = [...current.values()];
    for (const listener of this.listeners) listener(tokenId, snapshot);
  }
}
