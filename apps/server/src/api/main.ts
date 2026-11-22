import { CHAIN_NETWORKS, CauldronIndexerClient, type ChainClientEvent } from '@atprice/chain';
import { createNodeChainClient } from '@atprice/chain/node';
import { marketDomain } from '@atprice/core';
import { ChainNetworkProvider } from '../chain-provider.js';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/pool.js';
import { EnvValidationError, MIN_DISTINCT_ELECTRUM_HOSTS, distinctHosts, loadApiEnv } from '../env.js';
import { FACT, headerServer, readFacts } from '../facts.js';
import { IndependentConnection } from '../health/connection.js';
import { IndependentEvaluator } from '../health/evaluator.js';
import { createAnalytics } from '../analytics.js';
import { createLogger } from '../logger.js';
import { OrderObserver } from '../orders/observe.js';
import { nominationsFromIndexer, readLivePools } from '../pools/reader.js';
import { QuoteService } from './quotes.js';
import { buildServer } from './server.js';

const bootLogger = createLogger('api', process.env.LOG_LEVEL ?? 'info');

const main = async (): Promise<void> => {
  const env = loadApiEnv();
  const logger = createLogger('api', env.logLevel);
  const db = createDb(env.databaseUrl, 'atprice-api');
  await migrate(db);

  const endpoints = env.electrumServers ?? CHAIN_NETWORKS[env.network].nodeElectrum;
  if (distinctHosts(endpoints) < MIN_DISTINCT_ELECTRUM_HOSTS)
    throw new Error('the Electrum list needs two distinct hosts for an independent health evaluator');
  const onEvent = (connection: string) => (event: ChainClientEvent) =>
    logger.info({ connection, ...event }, 'electrum event');
  const chain = createNodeChainClient(env.network, {
    endpoints,
    application: 'atprice-api',
    onEvent: onEvent('api'),
  });
  const evaluatorConnection = new IndependentConnection(
    endpoints,
    (ordered) =>
      createNodeChainClient(env.network, {
        endpoints: ordered,
        application: 'atprice-evaluator',
        onEvent: onEvent('evaluator'),
      }),
    logger,
  );
  await Promise.all([chain.connect(), evaluatorConnection.connect()]);

  const indexer = new CauldronIndexerClient({ network: env.network });
  const app = await buildServer({
    db,
    network: env.network,
    webOrigin: env.webOrigin,
    trustProxy: env.trustProxy,
    sweepIntervalMs: env.sweepIntervalMs,
    evalIntervalMs: env.healthEvalIntervalMs,
    chain,
    observer: new OrderObserver(chain, env.network, marketDomain(env.network)),
    provider: new ChainNetworkProvider(chain, env.network),
    quotes: new QuoteService(indexer, chain),
    logger,
    analytics: createAnalytics(logger, env.network, env.cohort),
  });

  const evaluator = new IndependentEvaluator({
    db,
    network: env.network,
    chain: {
      getTip: () => evaluatorConnection.current.getTip(),
      getUtxos: (locking) => evaluatorConnection.current.getUtxos(locking),
      get endpointHost() {
        return evaluatorConnection.host;
      },
    },
    pools: async (tokenId) =>
      (
        await readLivePools(
          evaluatorConnection.current,
          tokenId,
          nominationsFromIndexer(await indexer.activePools(tokenId)),
        )
      ).pools,
  });
  let evaluating = false;
  const evaluate = async (): Promise<void> => {
    if (evaluating) return;
    evaluating = true;
    try {
      const header = (await readFacts(db, env.network)).get(FACT.header);
      await evaluatorConnection.ensureAwayFrom(headerServer(header?.value));
      const run = await evaluator.run();
      logger.info({ candidates: run.candidates, tip: run.tipHeight }, 'evaluator run');
    } catch (error) {
      logger.error({ err: error }, 'evaluator run failed');
    } finally {
      evaluating = false;
    }
  };
  await evaluate();
  const timer = setInterval(() => void evaluate(), env.healthEvalIntervalMs);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'api stopping');
    clearInterval(timer);
    void app
      .close()
      .then(() => Promise.all([chain.close(), evaluatorConnection.close()]))
      .then(() => db.end())
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  await app.listen({ port: env.apiPort, host: env.apiHost });
};

main().catch((error: unknown) => {
  if (error instanceof EnvValidationError) bootLogger.fatal({ issues: error.issues }, 'invalid environment');
  else bootLogger.fatal({ err: error }, 'api failed to start');
  process.exit(1);
});
