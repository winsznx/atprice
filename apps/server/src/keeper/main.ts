import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  CHAIN_NETWORKS,
  CauldronBroadcastClient,
  CauldronIndexerClient,
  type ChainClientEvent,
} from '@atprice/chain';
import { createNodeChainClient, createNodeRostrumClient } from '@atprice/chain/node';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/pool.js';
import { EnvValidationError, loadKeeperEnv } from '../env.js';
import { createAnalytics } from '../analytics.js';
import { createLogger } from '../logger.js';
import { Keeper } from './keeper.js';

const bootLogger = createLogger('keeper', process.env.LOG_LEVEL ?? 'info');

const main = async (): Promise<void> => {
  const env = loadKeeperEnv();
  const logger = createLogger('keeper', env.logLevel);
  const db = createDb(env.databaseUrl, 'atprice-keeper');
  await migrate(db);
  const endpoints = env.electrumServers ?? CHAIN_NETWORKS[env.network].nodeElectrum;
  const onEvent = (connection: string) => (event: ChainClientEvent) =>
    logger.info({ connection, ...event }, 'electrum event');
  const keeper = new Keeper({
    db,
    databaseUrl: env.databaseUrl,
    network: env.network,
    chain: createNodeChainClient(env.network, {
      endpoints,
      application: 'atprice-keeper',
      onEvent: onEvent('orders'),
    }),
    intentChain: createNodeChainClient(env.network, {
      endpoints,
      application: 'atprice-keeper-intents',
      onEvent: onEvent('intents'),
    }),
    rostrum: createNodeRostrumClient(env.network, {
      onEvent: (event) => logger.info({ connection: 'rostrum', ...event }, 'rostrum event'),
    }),
    indexerClient: new CauldronIndexerClient({ network: env.network }),
    cauldronBroadcast: CauldronBroadcastClient.forNetwork(env.network),
    sweepIntervalMs: env.sweepIntervalMs,
    analytics: createAnalytics(logger, env.network, env.cohort),
    keeperId: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    logger,
  });
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'keeper stopping');
    void keeper
      .stop()
      .then(() => db.end())
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  await keeper.start();
};

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) bootLogger.fatal({ issues: error.issues }, 'invalid environment');
  else bootLogger.fatal({ err: error }, 'keeper failed to start');
  process.exit(1);
});
