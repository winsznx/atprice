import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hexToBin } from '@bitauth/libauth';
import { isCauldronV0Pool, poolLockingBytecode } from '@atprice/core';
import {
  CHAIN_NETWORKS,
  CauldronIndexerClient,
  type ChainClient,
  type RostrumPoolClient,
} from '../../src/index.js';
import { createNodeChainClient, createNodeRostrumClient } from '../../src/node.js';

// Read-only checks against public chipnet infrastructure. Nothing is signed or broadcast.
const TOKEN = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';

describe('chipnet live (read only)', () => {
  let chain: ChainClient;
  let rostrum: RostrumPoolClient;

  beforeAll(async () => {
    chain = createNodeChainClient('chipnet');
    rostrum = createNodeRostrumClient('chipnet');
    await Promise.all([chain.connect(), rostrum.connect()]);
  });

  afterAll(async () => {
    await Promise.all([chain.close(), rostrum.close()]);
  });

  it('connects to a chipnet Fulcrum whose genesis matches', async () => {
    expect(chain.connected).toBe(true);
    expect(chain.genesisHash).toBe(CHAIN_NETWORKS.chipnet.genesisHash);
    const tip = await chain.getTip();
    expect(tip.height).toBeGreaterThan(340_000);
    expect(await chain.getBlockHash(tip.height)).toBe(tip.hash);
  });

  it('subscribes to headers and gets the current tip', async () => {
    const header = await new Promise<number>((resolve, reject) => {
      chain.subscribeHeaders((value) => resolve(value.height)).catch(reject);
    });
    expect(header).toBeGreaterThan(340_000);
  });

  it('reads PUSDTEST pools from the indexer and confirms each against a fresh Electrum read', async () => {
    const pools = await new CauldronIndexerClient({ network: 'chipnet' }).activePools(TOKEN);
    expect(pools.length).toBeGreaterThan(0);
    const pool = pools[0];
    if (pool === undefined) throw new Error('no pool');
    const locking = poolLockingBytecode(hexToBin(pool.ownerPkh));
    expect(isCauldronV0Pool(locking, hexToBin(pool.ownerPkh))).toBe(true);
    const utxos = await chain.getUtxos(locking);
    const live = utxos.find((utxo) => utxo.token?.category === TOKEN && utxo.token.nft === undefined);
    expect(live).toBeDefined();
    expect(live?.token?.amount).toBeGreaterThan(0n);
  });

  it('subscribes to PUSDTEST pools on Rostrum', async () => {
    const pools = await rostrum.subscribe(TOKEN);
    expect(pools.length).toBeGreaterThan(0);
    expect(pools.every((pool) => pool.tokenId === TOKEN && pool.tokens > 0n)).toBe(true);
  });
});
