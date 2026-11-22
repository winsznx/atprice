import {
  binToHex,
  decodeTransactionBch,
  encodeTransactionBch,
  hashTransaction,
  hexToBin,
  type TransactionCommon,
} from '@bitauth/libauth';
import {
  BroadcastRejectedError,
  ChainError,
  scripthashOf,
  type ChainHeader,
  type ChainUtxo,
  type HistoryEntry,
  type TransactionStatus,
  type Unsubscribe,
} from '@atprice/chain';

interface StoredTx {
  readonly txid: string;
  readonly hex: string;
  readonly transaction: TransactionCommon;
  height: number | null;
}

/** What every connection to one fake server sees: transactions, block hashes and the tip. */
interface Ledger {
  readonly txs: Map<string, StoredTx>;
  readonly blockHashes: Map<number, string>;
  readonly broadcasts: string[];
  readonly connections: Set<FakeChain>;
  tipHeight: number;
}

export interface FakeReconnect {
  /** True for a failover to another server, false for the same server coming back. */
  readonly failover: boolean;
  /** The server the connection lands on (defaults to the current one). */
  readonly host?: string;
}

/**
 * An in-memory Electrum server for tests: it answers history, UTXO, transaction and header queries
 * from the transactions it holds, the way Fulcrum derives them (history = transactions that pay or
 * spend a script, UTXOs = outputs no held transaction spends). `connection()` opens a second
 * connection to the same data, and the connection methods mirror `ChainClient` so the keeper can run
 * on it unchanged.
 */
export class FakeChain {
  private readonly ledger: Ledger;
  connected = true;
  endpoint: { host: string; port: number; transport: 'tls' } = {
    host: 'fake.chain',
    port: 50002,
    transport: 'tls',
  };
  /** When set, `broadcast` rejects with this node text. */
  rejectBroadcastWith: string | undefined;
  /** Runs just before a broadcast is checked: lets a test put a conflicting spend in first. */
  beforeBroadcast: ((hex: string) => void) | undefined;
  /** When true, new address subscriptions fail the way a dropped or overloaded server fails them. */
  failSubscriptions = false;
  readonly connectCalls: number[] = [];
  private readonly listeners = new Map<string, Set<(status: string | null) => void>>();
  private readonly headerListeners = new Set<(header: ChainHeader) => void>();
  private readonly reconnectHooks = new Set<
    (info: { endpoint: { host: string }; failover: boolean }) => Promise<void> | void
  >();

  constructor(shared?: FakeChain) {
    this.ledger = shared?.ledger ?? {
      txs: new Map(),
      blockHashes: new Map(),
      broadcasts: [],
      connections: new Set(),
      tipHeight: 342_300,
    };
    this.ledger.connections.add(this);
  }

  /** A second connection to the same server data (the keeper's intent connection, the evaluator's). */
  connection(host = 'fake.chain'): FakeChain {
    const other = new FakeChain(this);
    other.endpoint = { ...other.endpoint, host };
    return other;
  }

  get txs(): Map<string, StoredTx> {
    return this.ledger.txs;
  }

  get blockHashes(): Map<number, string> {
    return this.ledger.blockHashes;
  }

  get broadcasts(): string[] {
    return this.ledger.broadcasts;
  }

  get tipHeight(): number {
    return this.ledger.tipHeight;
  }

  set tipHeight(height: number) {
    this.ledger.tipHeight = height;
  }

  add(transaction: TransactionCommon, height: number | null = null): string {
    const encoded = encodeTransactionBch(transaction);
    const txid = hashTransaction(encoded);
    this.txs.set(txid, { txid, hex: binToHex(encoded), transaction, height });
    // A real server never reports a confirmation above its own tip.
    if (height !== null && height > this.tipHeight) this.tipHeight = height;
    return txid;
  }

  addHex(hex: string, height: number | null = null): string {
    const decoded = decodeTransactionBch(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    return this.add(decoded, height);
  }

  confirm(txid: string, height: number): void {
    const stored = this.txs.get(txid);
    if (stored === undefined) throw new Error(`unknown tx ${txid}`);
    stored.height = height;
    if (height > this.tipHeight) this.tipHeight = height;
  }

  drop(txid: string): void {
    this.txs.delete(txid);
  }

  blockHash(height: number): string {
    return (
      this.blockHashes.get(height) ?? binToHex(new Uint8Array(32).fill(height % 251)).replace(/^../, 'bb')
    );
  }

  reorgBlock(height: number): void {
    this.blockHashes.set(height, 'cc'.repeat(32));
  }

  private outputsOf(txid: string): TransactionCommon['outputs'] | undefined {
    return this.txs.get(txid)?.transaction.outputs;
  }

  private spender(txid: string, vout: number): StoredTx | undefined {
    for (const stored of this.txs.values()) {
      if (
        stored.transaction.inputs.some(
          (input) => binToHex(input.outpointTransactionHash) === txid && input.outpointIndex === vout,
        )
      ) {
        return stored;
      }
    }
    return undefined;
  }

  async getRawTransaction(txid: string): Promise<string> {
    const stored = this.txs.get(txid);
    if (stored === undefined)
      throw new ChainError(
        'request_failed',
        'blockchain.transaction.get: No such mempool or blockchain transaction',
      );
    return stored.hex;
  }

  async getTransactionStatus(txid: string): Promise<TransactionStatus> {
    const stored = this.txs.get(txid);
    if (stored === undefined)
      throw new ChainError('request_failed', 'No such mempool or blockchain transaction');
    return {
      hex: stored.hex,
      confirmations: stored.height === null ? 0 : this.tipHeight - stored.height + 1,
      blockHash: stored.height === null ? null : this.blockHash(stored.height),
    };
  }

  async getHistory(lockingBytecode: Uint8Array): Promise<HistoryEntry[]> {
    const target = binToHex(lockingBytecode);
    const entries: HistoryEntry[] = [];
    for (const stored of this.txs.values()) {
      const pays = stored.transaction.outputs.some((output) => binToHex(output.lockingBytecode) === target);
      const spends = stored.transaction.inputs.some((input) => {
        const previous = this.outputsOf(binToHex(input.outpointTransactionHash))?.[input.outpointIndex];
        return previous !== undefined && binToHex(previous.lockingBytecode) === target;
      });
      if (pays || spends) entries.push({ txid: stored.txid, height: stored.height ?? 0 });
    }
    return entries.sort(
      (a, b) => (a.height <= 0 ? Infinity : a.height) - (b.height <= 0 ? Infinity : b.height),
    );
  }

  async getUtxos(lockingBytecode: Uint8Array): Promise<ChainUtxo[]> {
    const target = binToHex(lockingBytecode);
    const utxos: ChainUtxo[] = [];
    for (const stored of this.txs.values()) {
      stored.transaction.outputs.forEach((output, vout) => {
        if (binToHex(output.lockingBytecode) !== target || this.spender(stored.txid, vout) !== undefined)
          return;
        utxos.push({
          txid: stored.txid,
          vout,
          satoshis: output.valueSatoshis,
          height: stored.height ?? 0,
          ...(output.token && {
            token: {
              category: binToHex(output.token.category),
              amount: output.token.amount,
              ...(output.token.nft && {
                nft: {
                  capability: output.token.nft.capability,
                  commitment: binToHex(output.token.nft.commitment),
                },
              }),
            },
          }),
        });
      });
    }
    return utxos;
  }

  async getBlockHash(height: number): Promise<string> {
    return this.blockHash(height);
  }

  async getTip(): Promise<ChainHeader> {
    return { height: this.tipHeight, hex: '00'.repeat(80), hash: this.blockHash(this.tipHeight) };
  }

  async broadcast(hex: string): Promise<string> {
    this.beforeBroadcast?.(hex);
    if (this.rejectBroadcastWith !== undefined)
      throw new BroadcastRejectedError('electrum', this.rejectBroadcastWith);
    const decoded = decodeTransactionBch(hexToBin(hex));
    if (typeof decoded === 'string') throw new BroadcastRejectedError('electrum', 'TX decode failed');
    for (const input of decoded.inputs) {
      const txid = binToHex(input.outpointTransactionHash);
      if (
        this.outputsOf(txid)?.[input.outpointIndex] === undefined ||
        this.spender(txid, input.outpointIndex) !== undefined
      ) {
        throw new BroadcastRejectedError(
          'electrum',
          'the transaction was rejected by network rules.\n\nbad-txns-inputs-missingorspent',
        );
      }
    }
    this.broadcasts.push(hex);
    const txid = this.add(decoded, null);
    this.notifyTouched(decoded);
    return txid;
  }

  /** Adds a transaction and notifies every script it pays or spends, as a server does on mempool entry. */
  publish(transaction: TransactionCommon, height: number | null = null): string {
    const txid = this.add(transaction, height);
    this.notifyTouched(transaction);
    return txid;
  }

  publishHex(hex: string, height: number | null = null): string {
    const decoded = decodeTransactionBch(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    return this.publish(decoded, height);
  }

  /** Confirms a held transaction and notifies the scripts it touches. */
  confirmAndNotify(txid: string, height: number): void {
    this.confirm(txid, height);
    const stored = this.txs.get(txid);
    if (stored !== undefined) this.notifyTouched(stored.transaction);
  }

  private notifyTouched(transaction: TransactionCommon): void {
    const scripts = new Set<string>(transaction.outputs.map((output) => binToHex(output.lockingBytecode)));
    for (const input of transaction.inputs) {
      const previous = this.outputsOf(binToHex(input.outpointTransactionHash))?.[input.outpointIndex];
      if (previous !== undefined) scripts.add(binToHex(previous.lockingBytecode));
    }
    for (const script of scripts) this.notify(hexToBin(script));
  }

  async subscribeAddress(
    lockingBytecode: Uint8Array,
    listener: (status: string | null) => void,
  ): Promise<Unsubscribe> {
    if (this.failSubscriptions || !this.connected)
      throw new ChainError('request_failed', 'blockchain.scripthash.subscribe: server busy');
    const key = scripthashOf(lockingBytecode);
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    listener(null);
    return async () => {
      set.delete(listener);
    };
  }

  /** A status notification for one script, delivered on every connection to this server. */
  notify(lockingBytecode: Uint8Array, status = 'ab'.repeat(32)): void {
    const key = scripthashOf(lockingBytecode);
    for (const connection of this.ledger.connections) {
      for (const listener of connection.listeners.get(key) ?? []) listener(status);
    }
  }

  subscribedCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }

  get subscriptionCount(): number {
    return this.subscribedCount();
  }

  get subscriptionsHealthy(): boolean {
    return this.connected && !this.failSubscriptions;
  }

  async retryFailedSubscriptions(): Promise<boolean> {
    return this.subscriptionsHealthy;
  }

  async connect(): Promise<void> {
    this.connectCalls.push(Date.now());
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  onReconnect(
    hook: (info: { endpoint: { host: string }; failover: boolean }) => Promise<void> | void,
  ): () => void {
    this.reconnectHooks.add(hook);
    return () => this.reconnectHooks.delete(hook);
  }

  async subscribeHeaders(listener: (header: ChainHeader) => void): Promise<Unsubscribe> {
    this.headerListeners.add(listener);
    listener(await this.getTip());
    return async () => {
      this.headerListeners.delete(listener);
    };
  }

  /** Mines (or announces) a header: moves the tip when `height` is given and notifies header listeners. */
  async emitHeader(height?: number): Promise<void> {
    if (height !== undefined) this.tipHeight = height;
    const header = await this.getTip();
    for (const listener of this.headerListeners) listener(header);
  }

  /** Announces an arbitrary header (a lagging server's, or one delivered out of order). */
  announceHeader(header: ChainHeader): void {
    for (const listener of this.headerListeners) listener(header);
  }

  /**
   * What `ChainClient` does after a reconnect or failover: every subscription is re-issued (listeners
   * get the current status again), then the callers' reconnect hooks run in order.
   */
  async reconnect({ failover, host }: FakeReconnect): Promise<void> {
    if (host !== undefined) this.endpoint = { ...this.endpoint, host };
    this.connected = true;
    const header = await this.getTip();
    for (const listener of this.headerListeners) listener(header);
    for (const set of this.listeners.values()) for (const listener of set) listener('ab'.repeat(32));
    for (const hook of this.reconnectHooks) await hook({ endpoint: this.endpoint, failover });
  }
}
