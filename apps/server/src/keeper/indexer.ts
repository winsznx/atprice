import { binToHex, hexToBin } from '@bitauth/libauth';
import type { ChainHeader, Unsubscribe } from '@atprice/chain';
import { isTerminalStatus, orderLockingBytecode, type Network, type OrderParams } from '@atprice/core';
import type { Logger } from 'pino';
import type { Analytics } from '../analytics.js';
import type { Db } from '../db/pool.js';
import { writeHeaderFact } from '../facts.js';
import { paramsFromRow, type OrderRow } from '../orders/model.js';
import type { OrderObserver } from '../orders/observe.js';
import { markReorgedExecutions, recordObservation } from '../orders/record.js';
import { syncOrderAddress, type SyncResult } from '../orders/sync.js';

export interface AddressSubscriber {
  subscribeAddress(
    lockingBytecode: Uint8Array,
    listener: (status: string | null) => void,
  ): Promise<Unsubscribe>;
  getBlockHash(height: number): Promise<string>;
}

export interface IndexerDeps {
  readonly db: Db;
  readonly network: Network;
  readonly chain: AddressSubscriber;
  readonly observer: OrderObserver;
  readonly logger: Logger;
  readonly analytics: Analytics;
  /** An order of this token became OPEN: the executor runs for it. */
  readonly onOrderOpen: (tokenId: string) => void;
}

interface Tracked {
  readonly params: OrderParams;
  readonly tokenId: string;
  unsubscribe: Unsubscribe | undefined;
}

export interface HeaderOutcome {
  /** False when the header was below the recorded tip and so ignored. */
  readonly recorded: boolean;
  readonly reorged: number;
}

/** Recorded confirmations are re-checked this many blocks deep on every header (architecture.md). */
export const REORG_DEPTH = 10;

/**
 * The order indexer: subscribes every non-terminal order address, turns status notifications into full
 * address resyncs through the one observation path, and checks recorded confirmations against the best
 * chain on every header.
 */
export class Indexer {
  private readonly tracked = new Map<string, Tracked>();
  private readonly inFlight = new Map<string, Promise<SyncResult[]>>();
  private readonly again = new Set<string>();
  private headerQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: IndexerDeps) {}

  get trackedCount(): number {
    return this.tracked.size;
  }

  /** Addresses tracked but not subscribed on the current connection. */
  get unsubscribedCount(): number {
    return [...this.tracked.values()].filter((entry) => entry.unsubscribe === undefined).length;
  }

  /** Loads every non-terminal instance from Postgres and subscribes any address not yet tracked. */
  async loadWorkingSet(): Promise<number> {
    const { rows } = await this.deps.db.query<OrderRow>(
      `SELECT DISTINCT ON (order_locking_bytecode) * FROM orders
        WHERE network = $1 AND status NOT IN ('FILLED', 'CANCELLED')
        ORDER BY order_locking_bytecode, instance_kind`,
      [this.deps.network],
    );
    const live = new Set<string>();
    for (const row of rows) {
      live.add(row.order_locking_bytecode);
      await this.track(paramsFromRow(row));
    }
    for (const [lockingHex, entry] of this.tracked) {
      if (!live.has(lockingHex)) await this.untrack(lockingHex, entry);
    }
    return rows.length;
  }

  /** Starts watching an order address (new registration, funded intent, or the working set). */
  async track(params: OrderParams): Promise<void> {
    const lockingHex = binToHex(orderLockingBytecode(params));
    let entry = this.tracked.get(lockingHex);
    if (entry === undefined) {
      entry = { params, tokenId: params.tokenCategory, unsubscribe: undefined };
      this.tracked.set(lockingHex, entry);
    }
    if (entry.unsubscribe !== undefined) return;
    try {
      let first = true;
      entry.unsubscribe = await this.deps.chain.subscribeAddress(hexToBin(lockingHex), () => {
        // The subscribe call itself delivers the current status; the boot or sweep backfill covers it.
        if (first) {
          first = false;
          return;
        }
        void this.sync(lockingHex, 'status_notification', false).catch((error: unknown) =>
          this.deps.logger.error(
            { err: error, address: lockingHex },
            'order resync after notification failed',
          ),
        );
      });
    } catch (error) {
      this.deps.logger.warn({ err: error, address: lockingHex }, 'order address subscription failed');
    }
  }

  private async untrack(lockingHex: string, entry: Tracked): Promise<void> {
    this.tracked.delete(lockingHex);
    if (entry.unsubscribe !== undefined) await entry.unsubscribe().catch(() => undefined);
  }

  /** Resolves once every resync and header already started has finished (orderly shutdown). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
    await this.headerQueue;
  }

  /** Resyncs one address; concurrent requests for the same address coalesce into one follow-up. */
  async sync(lockingHex: string, reason: string, sweep: boolean): Promise<SyncResult[]> {
    const entry = this.tracked.get(lockingHex);
    if (entry === undefined) return [];
    const running = this.inFlight.get(lockingHex);
    if (running !== undefined) {
      this.again.add(lockingHex);
      return running;
    }
    const run = (async () => {
      const results = await syncOrderAddress(this.deps.db, this.deps.observer, entry.params, {
        sweep,
        reason,
        analytics: this.deps.analytics,
      });
      await this.afterSync(lockingHex, entry, results);
      return results;
    })().finally(() => {
      this.inFlight.delete(lockingHex);
      if (this.again.delete(lockingHex)) {
        void this.sync(lockingHex, `${reason}:coalesced`, false).catch((error: unknown) =>
          this.deps.logger.error({ err: error, address: lockingHex }, 'coalesced order resync failed'),
        );
      }
    });
    this.inFlight.set(lockingHex, run);
    return run;
  }

  /** Resyncs the address of one stored order now (for example after `order_spent` or `broadcast_conflict`). */
  async syncOrder(orderId: string, reason: string): Promise<SyncResult[]> {
    const { rows } = await this.deps.db.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
    const row = rows[0];
    if (row === undefined) return [];
    await this.track(paramsFromRow(row));
    return this.sync(row.order_locking_bytecode, reason, false);
  }

  /** Full backfill of every tracked address (boot, reconnect, failover, sweep). */
  async backfillAll(reason: string, sweep: boolean): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;
    for (const lockingHex of [...this.tracked.keys()]) {
      try {
        await this.sync(lockingHex, reason, sweep);
        synced += 1;
      } catch (error) {
        failed += 1;
        this.deps.logger.error({ err: error, address: lockingHex, reason }, 'order backfill failed');
      }
    }
    return { synced, failed };
  }

  /** After a reconnect the subscriptions are restored by the chain client; any lost here are retried. */
  async resubscribeMissing(): Promise<void> {
    for (const entry of this.tracked.values()) {
      if (entry.unsubscribe === undefined) await this.track(entry.params);
    }
  }

  private async afterSync(lockingHex: string, entry: Tracked, results: readonly SyncResult[]): Promise<void> {
    if (
      results.some(
        (result) =>
          result.outcome.status === 'OPEN' &&
          result.outcome.previous !== 'OPEN' &&
          result.supported !== false,
      )
    ) {
      this.deps.onOrderOpen(entry.tokenId);
    }
    const statuses = results.map((result) => result.outcome.status);
    const allSettled =
      statuses.length > 0 && statuses.every((status) => status === null || isTerminalStatus(status));
    if (allSettled) await this.untrack(lockingHex, entry);
  }

  /**
   * Records the header fact and checks recorded confirmations in the last REORG_DEPTH blocks. Headers
   * are handled one at a time in arrival order. A header below the recorded tip (a lagging server
   * after failover, or a stale notification) is neither recorded nor used for the reorg check: a
   * height the server has not reached yet is not evidence of a reorg.
   */
  onHeader(header: ChainHeader, server: string): Promise<HeaderOutcome> {
    const run = this.headerQueue.then(() => this.handleHeader(header, server));
    this.headerQueue = run.catch(() => undefined);
    return run;
  }

  private async handleHeader(header: ChainHeader, server: string): Promise<HeaderOutcome> {
    const recorded = await writeHeaderFact(this.deps.db, this.deps.network, {
      height: header.height,
      hash: header.hash,
      server,
    });
    if (!recorded) {
      this.deps.logger.warn(
        { height: header.height, server },
        'header below the recorded tip; not recorded and not checked for reorgs',
      );
      return { recorded: false, reorged: 0 };
    }
    return { recorded: true, reorged: await this.checkReorgs(header.height) };
  }

  /** Re-checks every recorded confirmation at or below `tipHeight` and within REORG_DEPTH of it. */
  async checkReorgs(tipHeight: number): Promise<number> {
    const { db, network, chain } = this.deps;
    const floor = tipHeight - REORG_DEPTH + 1;
    const { rows } = await db.query<{ height: number; hash: string }>(
      `SELECT DISTINCT height, hash FROM (
         SELECT funding_height AS height, funding_block_hash AS hash FROM orders WHERE network = $1 AND funding_height >= $2
         UNION SELECT spend_height, spend_block_hash FROM orders WHERE network = $1 AND spend_height >= $2
         UNION SELECT block_height, block_hash FROM executions WHERE network = $1 AND block_height >= $2 AND status = 'confirmed'
       ) recorded WHERE hash IS NOT NULL AND height <= $3`,
      [network, floor, tipHeight],
    );
    let reorged = 0;
    for (const recorded of rows) {
      const best = await chain.getBlockHash(recorded.height);
      if (best === recorded.hash) continue;
      this.deps.logger.warn(
        { height: recorded.height, recorded: recorded.hash, best },
        'recorded confirmation reorged out',
      );
      await markReorgedExecutions(db, recorded.hash);
      const { rows: affected } = await db.query<OrderRow>(
        `SELECT * FROM orders WHERE network = $1 AND (funding_block_hash = $2 OR spend_block_hash = $2)`,
        [network, recorded.hash],
      );
      for (const order of affected) {
        await recordObservation(db, {
          orderId: order.id,
          network,
          facts: { funding: 'confirmed', spend: { kind: 'none' } },
          funding: { txid: order.funding_txid, height: recorded.height, blockHash: recorded.hash },
          spend: undefined,
          forced: {
            derived: 'RECONCILIATION_REQUIRED',
            cause: 'reorg',
            detail: `block ${recorded.hash} at height ${recorded.height} is no longer in the best chain`,
          },
          sweep: false,
        });
        await this.track(paramsFromRow(order));
        await this.sync(order.order_locking_bytecode, 'reorg_resync', false);
        reorged += 1;
      }
    }
    return reorged;
  }
}
