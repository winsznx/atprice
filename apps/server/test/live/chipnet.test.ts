import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHAIN_NETWORKS,
  CauldronIndexerClient,
  type ChainClient,
  type RostrumPoolClient,
} from '@atprice/chain';
import { createNodeChainClient, createNodeRostrumClient } from '@atprice/chain/node';
import { SUPPORTED_MARKETS, pinnedSupply } from '@atprice/core';
import { QuoteService } from '../../src/api/quotes.js';
import { exchangeLabOutput } from '../../src/health/evaluator.js';
import { CORE_MATHS, keeperExecuteFee, quotePool } from '../../src/pools/quote.js';
import {
  nominationsFromIndexer,
  nominationsFromRostrum,
  readLivePools,
  type LivePool,
} from '../../src/pools/reader.js';

// Read-only checks against public chipnet infrastructure: nothing is signed or broadcast.
const [MARKET] = SUPPORTED_MARKETS.chipnet;
if (MARKET === undefined) throw new Error('no chipnet market');
const TOKEN = MARKET.tokenCategory;

describe('chipnet live (read only)', () => {
  let chain: ChainClient;
  let rostrum: RostrumPoolClient;
  const indexer = new CauldronIndexerClient({ network: 'chipnet' });
  let pools: readonly LivePool[] = [];

  beforeAll(async () => {
    chain = createNodeChainClient('chipnet', { application: 'atprice-live-test' });
    rostrum = createNodeRostrumClient('chipnet');
    await Promise.all([chain.connect(), rostrum.connect()]);
    pools = (await readLivePools(chain, TOKEN, nominationsFromIndexer(await indexer.activePools(TOKEN))))
      .pools;
  });

  afterAll(async () => {
    await Promise.all([chain.close(), rostrum.close()]);
  });

  it('connects only to a server whose genesis is chipnet', async () => {
    expect(chain.connected).toBe(true);
    expect(chain.genesisHash).toBe(CHAIN_NETWORKS.chipnet.genesisHash);
    expect((await chain.getTip()).height).toBeGreaterThan(342_000);
  });

  it('reads every indexer-nominated pool of the allowlisted market from Electrum as a genuine Cauldron V0 pool', () => {
    expect(pools.length).toBeGreaterThan(0);
    expect(
      pools.every(
        (pool) => pool.token.category === TOKEN && pool.reserves.tokens > 0n && pool.reserves.sats > 0n,
      ),
    ).toBe(true);
  });

  it('gets the same pool set from Rostrum cauldron.contract.subscribe and from the indexer', async () => {
    const live = await rostrum.subscribe(TOKEN);
    const viaRostrum = await readLivePools(chain, TOKEN, nominationsFromRostrum(live));
    expect(new Set(viaRostrum.pools.map((pool) => pool.outpoint))).toEqual(
      new Set(pools.map((pool) => pool.outpoint)),
    );
  });

  it('agrees to the unit with ExchangeLab on every live pool for the pinned supply (the health cross-check)', () => {
    const fee = keeperExecuteFee(2000n);
    const buy = { side: 'buy' as const, satoshis: 100_000n + 1000n + 2000n, tokenAmount: 0n };
    const sell = { side: 'sell' as const, satoshis: 2000n, tokenAmount: 25n };
    let compared = 0;
    for (const pool of pools) {
      for (const order of [buy, sell]) {
        const core = quotePool(CORE_MATHS, order, pool, fee);
        const lab = exchangeLabOutput(order.side, pool, pinnedSupply(order, fee));
        expect(lab).toBe(core?.output);
        if (core !== undefined) compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('quotes a buy through the API quote service on live pools', async () => {
    const quote = await new QuoteService(indexer, chain).quote(TOKEN, 'buy', 100_000n);
    expect(BigInt(quote.receive)).toBeGreaterThan(0n);
    expect(pools.map((pool) => pool.outpoint)).toContain(quote.pool.outpoint);
  });
});
