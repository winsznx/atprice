import { hexToBin } from '@bitauth/libauth';
import type {
  CauldronBroadcastClient,
  CauldronIndexerClient,
  ChainHeader,
  RostrumPoolClient,
  Unsubscribe,
} from '@atprice/chain';
import { SUPPORTED_MARKETS, marketDomain, poolLockingBytecode, type Network } from '@atprice/core';
import type { Logger } from 'pino';
import type { Analytics } from '../analytics.js';
import { ChainNetworkProvider, type ProviderChain } from '../chain-provider.js';
import { listen, type Listener } from '../db/listen.js';
import type { Db } from '../db/pool.js';
import { FACT, writeFact, type SubscriptionsFact, type SweepFact } from '../facts.js';
import { syncMarkets } from '../markets.js';
import { OrderObserver, type ChainReader } from '../orders/observe.js';
import { nominationsFromIndexer, nominationsFromRostrum, type PoolNominator } from '../pools/reader.js';
import type { PoolMaths } from '../pools/quote.js';
import { Executor, type Broadcaster, type ExecutorChain } from './executor.js';
import { Indexer, type AddressSubscriber } from './indexer.js';
import { IntentWatcher } from './intents.js';

/** What the keeper needs from one Electrum connection; `ChainClient` satisfies it. */
export interface KeeperChain extends AddressSubscriber, ChainReader, ExecutorChain, ProviderChain {
  readonly connected: boolean;
  readonly endpoint: { readonly host: string } | undefined;
  readonly subscriptionCount: number;
  readonly subscriptionsHealthy: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  onReconnect(
    hook: (info: {
      readonly endpoint: { readonly host: string };
      readonly failover: boolean;
    }) => Promise<void> | void,
  ): () => void;
  subscribeHeaders(listener: (header: ChainHeader) => void): Promise<Unsubscribe>;
  retryFailedSubscriptions(): Promise<boolean>;
}

export type KeeperPoolFeed = Pick<
  RostrumPoolClient,
  'connected' | 'lastUpdateAt' | 'poolsOf' | 'onChange' | 'connect' | 'close' | 'subscribe'
>;

export interface KeeperOptions {
  readonly db: Db;
  readonly databaseUrl: string;
  readonly network: Network;
  readonly chain: KeeperChain;
  /** A separate connection for intent addresses, so intent volume never crowds out order observation. */
  readonly intentChain: KeeperChain;
  readonly rostrum: KeeperPoolFeed;
  readonly indexerClient: Pick<CauldronIndexerClient, 'activePools'>;
  readonly cauldronBroadcast: Pick<CauldronBroadcastClient, 'broadcast'> | null;
  readonly sweepIntervalMs: number;
  readonly keeperId: string;
  readonly logger: Logger;
  readonly analytics: Analytics;
  readonly maths?: PoolMaths;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The keeper process (architecture.md, keeper): boot sequence, event triggers and the fallback sweep.
 * It holds no key; every transaction it broadcasts is fully authorized by the covenants it spends.
 */
export class Keeper {
  readonly indexer: Indexer;
  readonly intents: IntentWatcher;
  readonly executor: Executor;
  private readonly tokens: readonly string[];
  private readonly poolSubscriptions = new Map<string, Unsubscribe>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private sweeping: Promise<void> | undefined;
  private listener: Listener | undefined;
  private stopped = false;
  private readonly background = new Set<Promise<unknown>>();

  constructor(private readonly options: KeeperOptions) {
    const { db, network, chain, intentChain, logger, analytics } = options;
    const observer = new OrderObserver(chain, network, marketDomain(network));
    this.tokens = SUPPORTED_MARKETS[network].map((market) => market.tokenCategory);
    this.indexer = new Indexer({
      db,
      network,
      chain,
      observer,
      logger,
      analytics,
      onOrderOpen: (tokenId) => this.triggerToken(tokenId, 'order_open'),
    });
    this.intents = new IntentWatcher({
      db,
      network,
      chain: intentChain,
      observer,
      indexer: this.indexer,
      logger,
      analytics,
    });
    const broadcasters: Broadcaster[] = [{ name: 'electrum', broadcast: (hex) => chain.broadcast(hex) }];
    if (options.cauldronBroadcast !== null) {
      const cauldron = options.cauldronBroadcast;
      broadcasters.push({ name: 'cauldron', broadcast: (hex) => cauldron.broadcast(hex) });
    }
    this.executor = new Executor({
      db,
      network,
      chain,
      provider: new ChainNetworkProvider(chain, network),
      nominator: this.nominator(),
      broadcasters,
      keeperId: options.keeperId,
      logger,
      analytics,
      ...(options.maths !== undefined && { maths: options.maths }),
      onOrderSpent: async (orderId) => {
        await this.indexer.syncOrder(orderId, 'order_spent');
      },
    });
  }

  /**
   * Rostrum's live pool set nominates pools; if Rostrum is down the indexer REST list does, and the
   * source in use is recorded as a fact, never switched silently.
   */
  private nominator(): PoolNominator {
    return {
      nominate: async (tokenId) => {
        const { rostrum, indexerClient, db, network } = this.options;
        if (rostrum.connected && rostrum.lastUpdateAt(tokenId) !== undefined) {
          return nominationsFromRostrum(rostrum.poolsOf(tokenId));
        }
        await writeFact(db, network, `pool_source:${tokenId}`, {
          source: 'indexer_rest',
          reason: 'rostrum_unavailable',
        });
        this.options.logger.warn(
          { tokenId },
          'Rostrum unavailable; nominating pools from the indexer REST list',
        );
        return nominationsFromIndexer(await indexerClient.activePools(tokenId));
      },
    };
  }

  async start(): Promise<void> {
    const { db, network, chain, intentChain, rostrum, logger } = this.options;
    await chain.connect();
    await intentChain.connect();
    await writeFact(db, network, FACT.electrum, this.electrumState());
    try {
      await rostrum.connect();
    } catch (error) {
      logger.error({ err: error }, 'Rostrum connection failed at boot');
    }
    await writeFact(db, network, FACT.keeperBoot, { keeperId: this.options.keeperId, pid: process.pid });
    await syncMarkets(db, network);

    await this.executor.reconcileAttempts('boot');
    await this.indexer.loadWorkingSet();
    await this.intents.sweep();
    await this.subscribePools();
    await chain.subscribeHeaders((header) => {
      this.inBackground(
        this.indexer.onHeader(header, chain.endpoint?.host ?? 'unknown').then((outcome) => {
          if (outcome.recorded) for (const token of this.tokens) this.triggerToken(token, 'new_block');
        }),
        'header handling failed',
      );
    });
    await this.indexer.backfillAll('boot', false);
    await this.intents.backfill();

    chain.onReconnect(async (info) => {
      logger.warn(
        { endpoint: info.endpoint.host, failover: info.failover },
        'electrum reconnected; resubscribing and backfilling',
      );
      await this.indexer.resubscribeMissing();
      await this.indexer.backfillAll(info.failover ? 'failover' : 'reconnect', false);
      await this.writeSubscriptionsFact();
      for (const token of this.tokens) this.triggerToken(token, 'reconnect');
    });
    intentChain.onReconnect(async () => {
      await this.intents.sweep();
      await this.intents.backfill();
      await this.writeSubscriptionsFact();
    });
    rostrum.onChange((tokenId) => this.triggerToken(tokenId, 'pool_event'));

    this.listener = listen(
      this.options.databaseUrl,
      ['order_intent', 'order_registered'],
      (channel, payload) => {
        if (this.stopped) return;
        const handled =
          channel === 'order_intent'
            ? this.intents.onNotify(payload)
            : this.indexer.syncOrder(payload, 'registered');
        this.inBackground(handled, `notification handling failed on ${channel}`);
      },
      logger,
    );

    await this.sweep();
    this.sweepTimer = setInterval(() => {
      if (this.sweeping !== undefined) return;
      void this.sweep();
    }, this.options.sweepIntervalMs);
    logger.info({ network, keeperId: this.options.keeperId }, 'keeper started');
  }

  /** Stops triggers, then waits for every run already started before closing connections. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    await this.listener?.close();
    await this.sweeping;
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
    await Promise.all([this.indexer.settled(), this.intents.settled(), this.executor.settled()]);
    await Promise.all([
      this.options.chain.close(),
      this.options.intentChain.close(),
      this.options.rostrum.close(),
    ]);
  }

  private inBackground(work: Promise<unknown>, failure: string): void {
    const tracked = work
      .catch((error: unknown) => this.options.logger.error({ err: error }, failure))
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  private triggerToken(tokenId: string, reason: string): void {
    if (this.stopped || !this.tokens.includes(tokenId)) return;
    this.inBackground(this.executor.trigger(tokenId, reason), `executor run failed (${reason})`);
  }

  private async subscribePools(): Promise<void> {
    const { rostrum, chain, logger } = this.options;
    for (const token of this.tokens) {
      if (rostrum.connected) {
        await rostrum
          .subscribe(token)
          .catch((error: unknown) => logger.error({ err: error, token }, 'Rostrum pool subscription failed'));
      }
      let owners: string[];
      try {
        owners = [
          ...new Set((await this.nominator().nominate(token)).map((nomination) => nomination.ownerPkh)),
        ];
      } catch (error) {
        logger.error({ err: error, token }, 'pool nomination failed');
        continue;
      }
      // Each pool's script hash on Fulcrum: a cross-check of Rostrum and a second pool-event trigger.
      for (const owner of owners) {
        const key = `${token}:${owner}`;
        if (this.poolSubscriptions.has(key)) continue;
        let first = true;
        try {
          const unsubscribe = await chain.subscribeAddress(poolLockingBytecode(hexToBin(owner)), () => {
            if (first) {
              first = false;
              return;
            }
            this.triggerToken(token, 'pool_event');
          });
          this.poolSubscriptions.set(key, unsubscribe);
        } catch (error) {
          logger.warn({ err: error, token, owner }, 'pool script hash subscription failed');
        }
      }
    }
  }

  private electrumState(): Record<string, unknown> {
    const { chain, intentChain } = this.options;
    return {
      orders: {
        connected: chain.connected,
        server: chain.endpoint?.host ?? null,
        subscriptions: chain.subscriptionCount,
      },
      intents: {
        connected: intentChain.connected,
        server: intentChain.endpoint?.host ?? null,
        subscriptions: intentChain.subscriptionCount,
      },
    };
  }

  private async writeSubscriptionsFact(): Promise<void> {
    const { chain, intentChain, db, network } = this.options;
    if (chain.connected) await chain.retryFailedSubscriptions();
    if (intentChain.connected) await intentChain.retryFailedSubscriptions();
    await this.indexer.resubscribeMissing();
    const fact: SubscriptionsFact = {
      ok:
        chain.subscriptionsHealthy &&
        (intentChain.subscriptionCount === 0 ? intentChain.connected : intentChain.subscriptionsHealthy) &&
        this.indexer.unsubscribedCount === 0 &&
        this.intents.unsubscribedCount === 0,
      expected: this.indexer.trackedCount + this.intents.watchedCount,
      subscribed:
        this.indexer.trackedCount -
        this.indexer.unsubscribedCount +
        this.intents.watchedCount -
        this.intents.unsubscribedCount,
      intentConnectionOk: intentChain.connected,
    };
    await writeFact(db, network, FACT.subscriptions, fact);
  }

  /** The fallback sweep (architecture.md): every trigger's work, recomputed from chain truth. */
  async sweep(): Promise<void> {
    const run = (async () => {
      const { db, network, logger } = this.options;
      const startedAt = new Date();
      await writeFact(db, network, FACT.sweepStarted, { startedAt: startedAt.toISOString() });
      try {
        await this.executor.reconcileAttempts('sweep');
        await this.intents.sweep();
        await this.indexer.loadWorkingSet();
        await this.indexer.backfillAll('sweep', true);
        await this.subscribePools();
        for (const token of this.tokens) {
          await this.executor
            .trigger(token, 'sweep')
            .catch((error: unknown) => logger.error({ err: error, token }, 'executor sweep run failed'));
        }
        await this.writeSubscriptionsFact();
        await writeFact(db, network, FACT.electrum, this.electrumState());
        const endedAt = new Date();
        await writeFact(db, network, FACT.sweep, {
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime(),
        } satisfies SweepFact);
      } catch (error) {
        // A failed sweep writes no completion fact, so health reports sweep_stale rather than a false ok.
        logger.error({ err: error, message: describe(error) }, 'sweep failed');
      }
    })();
    this.sweeping = run.finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }
}
