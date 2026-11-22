import type { ChainHeader, ChainUtxo, HistoryEntry } from '@atprice/chain';
import { binToHex } from '@bitauth/libauth';
import type { RecoverChain } from '../../src/core/server';

/**
 * An in-memory Electrum server for tests: transactions by txid, unspent outputs and history by
 * locking bytecode, as `packages/chain` returns them.
 */
export class FakeChain implements RecoverChain {
  readonly transactions = new Map<string, string>();
  readonly utxos = new Map<string, ChainUtxo[]>();
  readonly history = new Map<string, HistoryEntry[]>();
  readonly broadcasts: string[] = [];
  private readonly addressListeners = new Map<string, Set<(status: string | null) => void>>();
  tip = 342_400;
  broadcastResult: (hex: string) => Promise<string> = async () => {
    throw new Error('no broadcast configured');
  };

  addTransaction(txid: string, hex: string): void {
    this.transactions.set(txid, hex);
  }

  setUtxos(lockingBytecode: Uint8Array, utxos: ChainUtxo[]): void {
    this.utxos.set(binToHex(lockingBytecode), utxos);
    for (const listener of this.addressListeners.get(binToHex(lockingBytecode)) ?? [])
      listener(`status-${utxos.length}`);
  }

  setHistory(lockingBytecode: Uint8Array, entries: HistoryEntry[]): void {
    this.history.set(binToHex(lockingBytecode), entries);
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async getRawTransaction(txid: string): Promise<string> {
    const hex = this.transactions.get(txid);
    if (hex === undefined) throw new Error(`No such mempool or blockchain transaction: ${txid}`);
    return hex;
  }

  async getUtxos(lockingBytecode: Uint8Array): Promise<ChainUtxo[]> {
    return this.utxos.get(binToHex(lockingBytecode)) ?? [];
  }

  async getHistory(lockingBytecode: Uint8Array): Promise<HistoryEntry[]> {
    return this.history.get(binToHex(lockingBytecode)) ?? [];
  }

  async getTip(): Promise<ChainHeader> {
    return { height: this.tip, hex: '00'.repeat(80), hash: '00'.repeat(32) };
  }

  async broadcast(hex: string): Promise<string> {
    this.broadcasts.push(hex);
    return this.broadcastResult(hex);
  }

  async subscribeAddress(
    lockingBytecode: Uint8Array,
    listener: (status: string | null) => void,
  ): Promise<() => Promise<void>> {
    const key = binToHex(lockingBytecode);
    const listeners = this.addressListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.addressListeners.set(key, listeners);
    listener(null);
    return async () => {
      listeners.delete(listener);
    };
  }

  async subscribeHeaders(listener: (header: ChainHeader) => void): Promise<() => Promise<void>> {
    listener(await this.getTip());
    return async () => undefined;
  }
}
