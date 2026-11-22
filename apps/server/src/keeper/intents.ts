import { hexToBin } from '@bitauth/libauth';
import type { Network } from '@atprice/core';
import type { Logger } from 'pino';
import type { Analytics } from '../analytics.js';
import { purgeIntentPrivacy } from '../intent-store.js';
import type { Db } from '../db/pool.js';
import { paramsFromJson, type OrderParamsJson } from '../orders/model.js';
import type { OrderObserver } from '../orders/observe.js';
import { syncOrderAddress } from '../orders/sync.js';
import type { AddressSubscriber, Indexer } from './indexer.js';

interface IntentRow {
  readonly id: string;
  readonly order_locking_bytecode: string;
  readonly params: OrderParamsJson;
}

interface Watched {
  readonly row: IntentRow;
  unsubscribe: (() => Promise<void>) | undefined;
}

export interface IntentWatcherDeps {
  readonly db: Db;
  readonly network: Network;
  /** A separate Electrum connection, so intent volume can never crowd out order observation. */
  readonly chain: AddressSubscriber;
  readonly observer: OrderObserver;
  readonly indexer: Indexer;
  readonly logger: Logger;
  readonly analytics: Analytics;
}

/**
 * Watches the addresses of short-lived order intents. When funding shows up, the order is recorded
 * through the one observation path, the intent is marked funded, and the indexer takes the address over.
 */
export class IntentWatcher {
  private readonly watched = new Map<string, Watched>();
  private readonly checking = new Set<Promise<void>>();

  constructor(private readonly deps: IntentWatcherDeps) {}

  get watchedCount(): number {
    return this.watched.size;
  }

  get unsubscribedCount(): number {
    return [...this.watched.values()].filter((entry) => entry.unsubscribe === undefined).length;
  }

  /** Resolves once every funding check already started has finished (orderly shutdown). */
  async settled(): Promise<void> {
    while (this.checking.size > 0) await Promise.allSettled([...this.checking]);
  }

  /** NOTIFY handler: the payload is the intent id. */
  async onNotify(intentId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(intentId) || this.watched.has(intentId)) return;
    const { rows } = await this.deps.db.query<IntentRow>(
      `SELECT id, order_locking_bytecode, params FROM order_intents WHERE id = $1 AND network = $2 AND status = 'live'`,
      [intentId, this.deps.network],
    );
    const row = rows[0];
    if (row !== undefined) await this.watch(row);
  }

  /**
   * Expires stale intents, subscribes every live intent not yet watched (covers missed NOTIFYs), and
   * applies the retention rules: full client IPs cut to /24 after an hour, settled intents gone after 7 days.
   */
  async sweep(): Promise<{ expired: number; watched: number; truncated: number; deleted: number }> {
    const { db, network } = this.deps;
    const purge = await purgeIntentPrivacy(db, network);
    const { rows: expired } = await db.query<{ id: string }>(
      `UPDATE order_intents SET status = 'expired' WHERE network = $1 AND status = 'live' AND expires_at < now() RETURNING id`,
      [network],
    );
    for (const { id } of expired) await this.unwatch(id);
    const { rows } = await db.query<IntentRow>(
      `SELECT id, order_locking_bytecode, params FROM order_intents WHERE network = $1 AND status = 'live'`,
      [network],
    );
    const live = new Set(rows.map((row) => row.id));
    for (const id of [...this.watched.keys()]) if (!live.has(id)) await this.unwatch(id);
    for (const row of rows) {
      const entry = this.watched.get(row.id);
      if (entry === undefined || entry.unsubscribe === undefined) await this.watch(row);
    }
    return { expired: expired.length, watched: this.watched.size, ...purge };
  }

  /** Checks every watched intent address once (boot and after reconnects of the intent connection). */
  async backfill(): Promise<void> {
    for (const entry of [...this.watched.values()]) {
      await this.check(entry.row).catch((error: unknown) =>
        this.deps.logger.error({ err: error, intentId: entry.row.id }, 'intent backfill check failed'),
      );
    }
  }

  private async watch(row: IntentRow): Promise<void> {
    const entry: Watched = this.watched.get(row.id) ?? { row, unsubscribe: undefined };
    this.watched.set(row.id, entry);
    try {
      entry.unsubscribe = await this.deps.chain.subscribeAddress(
        hexToBin(row.order_locking_bytecode),
        (status) => {
          if (status === null) return;
          const check = this.check(row)
            .catch((error: unknown) =>
              this.deps.logger.error({ err: error, intentId: row.id }, 'intent funding check failed'),
            )
            .finally(() => this.checking.delete(check));
          this.checking.add(check);
        },
      );
    } catch (error) {
      this.deps.logger.warn({ err: error, intentId: row.id }, 'intent address subscription failed');
    }
  }

  private async unwatch(intentId: string): Promise<void> {
    const entry = this.watched.get(intentId);
    this.watched.delete(intentId);
    if (entry?.unsubscribe !== undefined) await entry.unsubscribe().catch(() => undefined);
  }

  private async check(row: IntentRow): Promise<void> {
    const params = paramsFromJson(row.params);
    const results = await syncOrderAddress(this.deps.db, this.deps.observer, params, {
      sweep: false,
      reason: 'intent_funding',
      analytics: this.deps.analytics,
    });
    const funded = results.find((result) => result.outcome.status !== null);
    if (funded === undefined) return;
    await this.deps.db.query(
      `UPDATE order_intents SET status = 'funded', funded_order_id = $2 WHERE id = $1 AND status = 'live'`,
      [row.id, funded.orderId],
    );
    await this.deps.indexer.track(params);
    await this.unwatch(row.id);
    this.deps.logger.info({ intentId: row.id, orderId: funded.orderId }, 'intent funded');
  }
}
