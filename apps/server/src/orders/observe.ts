import {
  binToHex,
  decodeTransactionBch,
  hexToBin,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import type { ChainHeader, ChainToken, ChainUtxo, HistoryEntry } from '@atprice/chain';
import {
  assessFunding,
  assessOrderInstance,
  bytesEqual,
  classifyOrderSpend,
  orderLockingBytecode,
  type MarketDomain,
  type Network,
  type OrderChainFacts,
  type OrderParams,
  type OrderSpend,
} from '@atprice/core';
import { outpointId, type OrderInstance } from './model.js';

/** The read side of a chain connection that observation needs; `ChainClient` satisfies it. */
export interface ChainReader {
  getRawTransaction(txid: string): Promise<string>;
  getHistory(lockingBytecode: Uint8Array): Promise<HistoryEntry[]>;
  getUtxos(lockingBytecode: Uint8Array): Promise<ChainUtxo[]>;
  getBlockHash(height: number): Promise<string>;
  getTip(): Promise<ChainHeader>;
}

export interface ObservedTx {
  readonly txid: string;
  /** Block height, or null while in the mempool. */
  readonly height: number | null;
  readonly blockHash: string | null;
}

export interface ObservedSpend extends ObservedTx {
  readonly classification: OrderSpend;
  readonly transaction: TransactionCommon;
  readonly inputIndex: number;
}

export interface InstanceObservation {
  readonly instance: OrderInstance;
  readonly facts: OrderChainFacts;
  readonly funding: ObservedTx;
  readonly spend: ObservedSpend | undefined;
}

export interface AddressObservation {
  readonly params: OrderParams;
  readonly lockingBytecode: Uint8Array;
  readonly instances: readonly InstanceObservation[];
  /** Funding outpoints the caller asked about that no longer appear in the address history. */
  readonly missing: readonly string[];
  /** The observing server's tip, read before its history, so a lagging server can't look current. */
  readonly tipHeight: number;
}

export class TransactionDecodeError extends Error {
  readonly reason = 'transaction_decode_failed';
  constructor(
    readonly txid: string,
    detail: string,
  ) {
    super(`transaction ${txid} does not decode: ${detail}`);
    this.name = 'TransactionDecodeError';
  }
}

const toChainToken = (output: Output): ChainToken | undefined =>
  output.token === undefined
    ? undefined
    : {
        category: binToHex(output.token.category),
        amount: output.token.amount,
        ...(output.token.nft && {
          nft: { capability: output.token.nft.capability, commitment: binToHex(output.token.nft.commitment) },
        }),
      };

const sameParams = (a: OrderParams, b: OrderParams): boolean =>
  a.side === b.side &&
  bytesEqual(a.ownerPkh, b.ownerPkh) &&
  bytesEqual(a.recipientLockingBytecode, b.recipientLockingBytecode) &&
  a.tokenCategory === b.tokenCategory &&
  a.minOut === b.minOut &&
  a.maxNetworkFee === b.maxNetworkFee &&
  bytesEqual(a.nonce, b.nonce);

const LRU_LIMIT = 2_000;

/**
 * Derives order instances and their chain facts from an order address's history. This is the only
 * place chain data becomes order state, used by register, the intent watcher, the indexer and resyncs.
 */
export class OrderObserver {
  private readonly confirmedTx = new Map<string, TransactionCommon>();

  constructor(
    private readonly chain: ChainReader,
    readonly network: Network,
    private readonly domain: MarketDomain,
  ) {}

  async transaction(txid: string): Promise<TransactionCommon> {
    const cached = this.confirmedTx.get(txid);
    if (cached !== undefined) return cached;
    const hex = await this.chain.getRawTransaction(txid);
    const decoded = decodeTransactionBch(hexToBin(hex));
    if (typeof decoded === 'string') throw new TransactionDecodeError(txid, decoded);
    return decoded;
  }

  private remember(txid: string, transaction: TransactionCommon): void {
    if (this.confirmedTx.size >= LRU_LIMIT) {
      const oldest = this.confirmedTx.keys().next().value;
      if (oldest !== undefined) this.confirmedTx.delete(oldest);
    }
    this.confirmedTx.set(txid, transaction);
  }

  /**
   * Observes every instance at the address of `params`. `parentId` names the funding instance for
   * strays when the funding transaction itself is not in the history (for example after it vanished).
   */
  async observeAddress(
    params: OrderParams,
    options: { readonly parentId?: string; readonly expected?: readonly string[] } = {},
  ): Promise<AddressObservation> {
    const lockingBytecode = orderLockingBytecode(params);
    const tipHeight = (await this.chain.getTip()).height;
    const history = await this.chain.getHistory(lockingBytecode);
    const blockHashes = new Map<number, string>();
    const blockHash = async (height: number | null): Promise<string | null> => {
      if (height === null) return null;
      const known = blockHashes.get(height);
      if (known !== undefined) return known;
      const hash = await this.chain.getBlockHash(height);
      blockHashes.set(height, hash);
      return hash;
    };

    const txs: { txid: string; height: number | null; transaction: TransactionCommon }[] = [];
    for (const entry of history) {
      const transaction = await this.transaction(entry.txid);
      const height = entry.height > 0 ? entry.height : null;
      if (height !== null) this.remember(entry.txid, transaction);
      txs.push({ txid: entry.txid, height, transaction });
    }

    interface Created {
      readonly id: string;
      readonly txid: string;
      readonly vout: number;
      readonly output: Output;
      readonly height: number | null;
      readonly transaction: TransactionCommon;
    }
    const created: Created[] = [];
    for (const tx of txs) {
      tx.transaction.outputs.forEach((output, vout) => {
        if (bytesEqual(output.lockingBytecode, lockingBytecode)) {
          created.push({
            id: outpointId(tx.txid, vout),
            txid: tx.txid,
            vout,
            output,
            height: tx.height,
            transaction: tx.transaction,
          });
        }
      });
    }

    const fundingIds = new Set<string>();
    const supportById = new Map<string, OrderInstance['support']>();
    for (const instance of created) {
      const funding = assessFunding(instance.transaction, this.domain);
      if (funding.params === undefined || funding.fundingVout !== instance.vout) continue;
      if (!sameParams(funding.params, params)) continue;
      fundingIds.add(instance.id);
      supportById.set(
        instance.id,
        funding.supported
          ? { supported: true, amount: funding.amount }
          : { supported: false, reason: funding.reason, detail: funding.detail },
      );
    }
    const parentId = [...fundingIds][0] ?? options.parentId ?? null;

    const instances: InstanceObservation[] = [];
    for (const instance of created) {
      const isFunding = fundingIds.has(instance.id);
      const token = toChainToken(instance.output);
      let support = supportById.get(instance.id);
      if (support === undefined) {
        const verdict = assessOrderInstance(
          params,
          { satoshis: instance.output.valueSatoshis, ...(token && { token }) },
          this.domain,
        );
        support = verdict.supported
          ? { supported: true, amount: verdict.amount }
          : { supported: false, reason: verdict.reason, detail: verdict.detail };
      }
      if (!isFunding && parentId === null) {
        // A stray with no known order is still tracked: it becomes its own (cancel-only) root.
        support = support.supported
          ? { supported: false, reason: 'funding_mismatch', detail: 'no funding record at this address' }
          : support;
      }

      let spend: ObservedSpend | undefined;
      for (const tx of txs) {
        const inputIndex = tx.transaction.inputs.findIndex(
          (input) =>
            binToHex(input.outpointTransactionHash) === instance.txid &&
            input.outpointIndex === instance.vout,
        );
        if (inputIndex < 0) continue;
        const classification = classifyOrderSpend(tx.transaction, inputIndex, params, {
          satoshis: instance.output.valueSatoshis,
          ...(token && { token }),
        });
        spend = {
          txid: tx.txid,
          height: tx.height,
          blockHash: await blockHash(tx.height),
          classification,
          transaction: tx.transaction,
          inputIndex,
        };
        break;
      }

      const orphan = !isFunding && parentId === null;
      instances.push({
        instance: {
          id: instance.id,
          network: this.network,
          instanceKind: isFunding || orphan ? 'funding' : 'stray',
          parentOrderId: isFunding || orphan ? null : parentId,
          txid: instance.txid,
          vout: instance.vout,
          params,
          satoshis: instance.output.valueSatoshis,
          token,
          support,
        },
        funding: {
          txid: instance.txid,
          height: instance.height,
          blockHash: await blockHash(instance.height),
        },
        spend,
        facts: {
          funding: instance.height === null ? 'mempool' : 'confirmed',
          spend:
            spend === undefined
              ? { kind: 'none' }
              : { kind: spend.classification.path, confirmed: spend.height !== null },
        },
      });
    }

    const seen = new Set(created.map((instance) => instance.id));
    return {
      params,
      lockingBytecode,
      instances,
      missing: (options.expected ?? []).filter((id) => !seen.has(id)),
      tipHeight,
    };
  }
}
