import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BroadcastRejectedError,
  CHAIN_NETWORKS,
  ChainClient,
  ChainError,
  NoEndpointReachableError,
  scripthashOf,
  type ChainClientEvent,
  type ReconnectInfo,
} from '../src/index.js';
import { FakeElectrumServer, fakeNetwork, waitFor } from './support/fake-electrum.js';

const GENESIS = CHAIN_NETWORKS.chipnet.genesisHash;
const MAINNET_GENESIS = CHAIN_NETWORKS.mainnet.genesisHash;
// A real chipnet header (height 342277) and the pool UTXO it was probed with.
const HEADER_HEX =
  '00a0482e5915a077824a32aa73bfb204a851aab35a106375f23bc5c12200000000000000a7d8ed8fb4fd7524b9e99ef9dfc06cd986ce7c7053edfdb22a8419fbcd25bc21ef56026b6ce6041af2cedfd4';
const POOL_LOCKING = Uint8Array.from(
  Buffer.from('aa20e5a8f7002215f734e98d55cb44253f9cf02870849739099936183e17caea80c887', 'hex'),
);
const POOL_SCRIPTHASH = '08cf3352c646b55a86c3361f0e5906451c8335769c9e8d23f2346413c02cb5ba';

const clients: ChainClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const makeClient = (servers: FakeElectrumServer[], events: ChainClientEvent[] = []): ChainClient => {
  const client = new ChainClient({
    network: 'chipnet',
    ...fakeNetwork(servers),
    failoverAfterMs: 80,
    reconnectAfterMs: 20,
    retryRoundDelayMs: 20,
    requestTimeoutMs: 2_000,
    onEvent: (event) => events.push(event),
  });
  clients.push(client);
  return client;
};

const statusServer = (host: string, statuses: Map<string, string | null>): FakeElectrumServer =>
  new FakeElectrumServer(host, GENESIS)
    .on('blockchain.scripthash.subscribe', ([scripthash]) => statuses.get(String(scripthash)) ?? null)
    .on('blockchain.headers.subscribe', () => ({ height: 342_277, hex: HEADER_HEX }));

describe('ChainClient connect', () => {
  it('skips a wrong-genesis server and an unreachable one, then connects to the first good server', async () => {
    const wrong = new FakeElectrumServer('wrong.example', MAINNET_GENESIS);
    const dead = new FakeElectrumServer('dead.example', GENESIS);
    dead.down = true;
    const good = new FakeElectrumServer('good.example', GENESIS);
    const events: ChainClientEvent[] = [];
    const client = makeClient([wrong, dead, good], events);
    await client.connect();
    expect(client.endpoint?.host).toBe('good.example');
    const failures = events.flatMap((event) => (event.kind === 'endpoint_failed' ? [event.failure] : []));
    expect(failures.map((failure) => [failure.endpoint.host, failure.reason])).toEqual([
      ['wrong.example', 'genesis_mismatch'],
      ['dead.example', 'request_failed'],
    ]);
  });

  it('throws NoEndpointReachableError naming every failure when no server qualifies', async () => {
    const client = makeClient([new FakeElectrumServer('a.example', MAINNET_GENESIS)]);
    const error = await client.connect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoEndpointReachableError);
    expect((error as NoEndpointReachableError).failures[0]?.reason).toBe('genesis_mismatch');
  });

  it('refuses requests before connecting', async () => {
    const client = makeClient([new FakeElectrumServer('a.example', GENESIS)]);
    await expect(client.getTip()).rejects.toMatchObject({ reason: 'not_connected' });
  });
});

describe('ChainClient typed helpers', () => {
  it('parses UTXOs with token data, history, tip and block hashes into exact types', async () => {
    const server = new FakeElectrumServer('a.example', GENESIS)
      .on('blockchain.scripthash.listunspent', ([scripthash, mode]) => {
        expect(scripthash).toBe(POOL_SCRIPTHASH);
        expect(mode).toBe('include_tokens');
        return [
          {
            height: 342_194,
            token_data: {
              amount: '9223372036854775807',
              category: 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
            },
            tx_hash: '2b846c36a25dde1265d5e85ae5a7926694d7882fd48917270d580f2ebd50150d',
            tx_pos: 0,
            value: 150_291_010,
          },
          { height: 0, tx_hash: 'aa'.repeat(32), tx_pos: 3, value: 1000 },
        ];
      })
      .on('blockchain.scripthash.get_history', () => [
        { height: 305_190, tx_hash: 'bb'.repeat(32) },
        { height: -1, tx_hash: 'cc'.repeat(32) },
      ])
      .on('blockchain.headers.get_tip', () => ({ height: 342_277, hex: HEADER_HEX }))
      .on('blockchain.block.header', () => HEADER_HEX);
    const client = makeClient([server]);
    await client.connect();
    const utxos = await client.getUtxos(POOL_LOCKING);
    expect(utxos[0]).toEqual({
      txid: '2b846c36a25dde1265d5e85ae5a7926694d7882fd48917270d580f2ebd50150d',
      vout: 0,
      satoshis: 150_291_010n,
      height: 342_194,
      token: {
        category: 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
        amount: 2n ** 63n - 1n,
      },
    });
    expect(utxos[1]?.token).toBeUndefined();
    expect(await client.getHistory(POOL_LOCKING)).toEqual([
      { txid: 'bb'.repeat(32), height: 305_190 },
      { txid: 'cc'.repeat(32), height: -1 },
    ]);
    const tip = await client.getTip();
    expect(tip.height).toBe(342_277);
    const once = createHash('sha256').update(Buffer.from(HEADER_HEX, 'hex')).digest();
    expect(tip.hash).toBe(Buffer.from(createHash('sha256').update(once).digest()).reverse().toString('hex'));
    expect(await client.getBlockHash(342_277)).toBe(tip.hash);
  });

  it('turns a node rejection into BroadcastRejectedError and a bad shape into response_invalid', async () => {
    const server = new FakeElectrumServer('a.example', GENESIS)
      .on('blockchain.transaction.broadcast', () => {
        throw new Error('the transaction was rejected by network rules.\n\nmissing-inputs');
      })
      .on('blockchain.headers.get_tip', () => ({ height: 'tall' }));
    const client = makeClient([server]);
    await client.connect();
    const rejected = await client.broadcast('00').catch((caught: unknown) => caught);
    expect(rejected).toBeInstanceOf(BroadcastRejectedError);
    expect((rejected as BroadcastRejectedError).detail).toContain('missing-inputs');
    await expect(client.getTip()).rejects.toSatisfy(
      (error: unknown) => error instanceof ChainError && error.reason === 'response_invalid',
    );
  });
});

describe('ChainClient subscriptions', () => {
  it('delivers the current status, then notifications, and stops after unsubscribe', async () => {
    const statuses = new Map<string, string | null>([[POOL_SCRIPTHASH, 'aa'.repeat(32)]]);
    const server = statusServer('a.example', statuses).on('blockchain.scripthash.unsubscribe', () => true);
    const client = makeClient([server]);
    await client.connect();
    const seen: (string | null)[] = [];
    const unsubscribe = await client.subscribeAddress(POOL_LOCKING, (status) => seen.push(status));
    expect(seen).toEqual(['aa'.repeat(32)]);
    server.notify('blockchain.scripthash.subscribe', [POOL_SCRIPTHASH, 'bb'.repeat(32)]);
    await waitFor(() => seen.length === 2);
    expect(client.subscriptionsHealthy).toBe(true);
    await unsubscribe();
    expect(server.count('blockchain.scripthash.unsubscribe')).toBe(1);
    server.notify('blockchain.scripthash.subscribe', [POOL_SCRIPTHASH, 'cc'.repeat(32)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(2);
    expect(client.subscriptionCount).toBe(0);
  });

  it('fails over to the next server, restores every subscription there and runs the reconnect hooks', async () => {
    const primary = statusServer('primary.example', new Map([[POOL_SCRIPTHASH, 'aa'.repeat(32)]]));
    const secondary = statusServer('secondary.example', new Map([[POOL_SCRIPTHASH, 'dd'.repeat(32)]]));
    const client = makeClient([primary, secondary]);
    await client.connect();
    const seen: (string | null)[] = [];
    const heights: number[] = [];
    await client.subscribeAddress(POOL_LOCKING, (status) => seen.push(status));
    await client.subscribeHeaders((header) => heights.push(header.height));
    const hooks: ReconnectInfo[] = [];
    client.onReconnect((info) => {
      expect(client.subscriptionsHealthy).toBe(true);
      hooks.push(info);
    });
    await primary.kill();
    expect(client.subscriptionsHealthy).toBe(false);
    await waitFor(() => hooks.length === 1);
    expect(hooks[0]).toEqual({
      endpoint: { host: 'secondary.example', port: 50002, transport: 'tls' },
      failover: true,
    });
    expect(seen).toEqual(['aa'.repeat(32), 'dd'.repeat(32)]);
    expect(heights).toEqual([342_277, 342_277]);
    expect(secondary.count('blockchain.scripthash.subscribe')).toBe(1);
    expect(client.endpoint?.host).toBe('secondary.example');
  });

  it('runs the hooks after the library reconnects to the same server, without failing over', async () => {
    const statuses = new Map([[POOL_SCRIPTHASH, 'aa'.repeat(32)]]);
    const server = statusServer('only.example', statuses);
    const client = new ChainClient({
      network: 'chipnet',
      ...fakeNetwork([server]),
      failoverAfterMs: 5_000,
      reconnectAfterMs: 20,
    });
    clients.push(client);
    await client.connect();
    const seen: (string | null)[] = [];
    await client.subscribeAddress(POOL_LOCKING, (status) => seen.push(status));
    const hooks: ReconnectInfo[] = [];
    client.onReconnect((info) => {
      hooks.push(info);
    });
    statuses.set(POOL_SCRIPTHASH, 'ee'.repeat(32));
    await server.blip();
    await waitFor(() => hooks.length === 1);
    await client.settled();
    expect(hooks[0]?.failover).toBe(false);
    expect(seen).toEqual(['aa'.repeat(32), 'ee'.repeat(32)]);
    expect(client.subscriptionsHealthy).toBe(true);
  });

  it('reports a subscription that fails to restore and retries it on demand', async () => {
    const primary = statusServer('primary.example', new Map([[POOL_SCRIPTHASH, 'aa'.repeat(32)]]));
    const secondary = new FakeElectrumServer('secondary.example', GENESIS);
    const events: ChainClientEvent[] = [];
    const client = makeClient([primary, secondary], events);
    await client.connect();
    await client.subscribeAddress(POOL_LOCKING, () => undefined);
    const reconnected = new Promise<void>((resolve) => client.onReconnect(() => resolve()));
    await primary.kill();
    await reconnected;
    expect(client.connected).toBe(true);
    expect(client.subscriptionsHealthy).toBe(false);
    expect(events.some((event) => event.kind === 'subscription_failed')).toBe(true);
    secondary.on('blockchain.scripthash.subscribe', () => null);
    expect(await client.retryFailedSubscriptions()).toBe(true);
  });

  it('computes Electrum script hashes as reversed sha256', () => {
    expect(scripthashOf(POOL_LOCKING)).toBe(POOL_SCRIPTHASH);
  });
});
