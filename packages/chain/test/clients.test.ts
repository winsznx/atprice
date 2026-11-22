import { describe, expect, it } from 'vitest';
import {
  BroadcastRejectedError,
  CHAIN_NETWORKS,
  CauldronBroadcastClient,
  CauldronIndexerClient,
  ElectrumEndpointParseError,
  RostrumPoolClient,
  explorerLinks,
  isAlreadyKnownRejection,
  isSpentInputRejection,
  parseElectrumEndpoints,
  parseJsonWithExactIntegers,
  rostrumUtxoHash,
  type RostrumPool,
} from '../src/index.js';
import { FakeElectrumServer, FakeSocket, waitFor } from './support/fake-electrum.js';

const TOKEN = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
const ZERO = '0'.repeat(64);

const fakeFetch =
  (status: number, body: string, seen: { url?: string; init?: RequestInit } = {}): typeof fetch =>
  async (input, init) => {
    seen.url = String(input);
    if (init !== undefined) seen.init = init;
    return new Response(body, { status });
  };

describe('rostrumUtxoHash', () => {
  it('matches the utxo hash Rostrum reported for a live chipnet pool', () => {
    // #given a pool UTXO observed through cauldron.contract.subscribe on 2026-11-22
    const txid = '2b846c36a25dde1265d5e85ae5a7926694d7882fd48917270d580f2ebd50150d';
    // #then the locally computed hash is the server's new_utxo_hash
    expect(rostrumUtxoHash(txid, 0)).toBe('dd720862cbd328b914e744444773fa1fdd6139133d7e069dcf7b43a4c83aefe4');
  });
});

describe('RostrumPoolClient', () => {
  const utxo = (fields: Partial<Record<string, unknown>>): Record<string, unknown> => ({
    is_withdrawn: false,
    pkh: 'a10dd0bc10a32b9ce10c8285a8bcaf586d00a140',
    sats: 150_291_010,
    token_amount: 29_909,
    token_id: TOKEN,
    spent_utxo_hash: ZERO,
    ...fields,
  });

  const setup = async (): Promise<{ server: FakeElectrumServer; client: RostrumPoolClient }> => {
    const server = new FakeElectrumServer('rostrum.example', CHAIN_NETWORKS.chipnet.genesisHash, '1.4.3').on(
      'cauldron.contract.subscribe',
      ([version, token]) => {
        expect(version).toBe(2);
        expect(token).toBe(TOKEN);
        return {
          type: 'initial',
          utxos: [utxo({ new_utxo_hash: 'a1'.repeat(32), new_utxo_txid: 'b1'.repeat(32), new_utxo_n: 0 })],
        };
      },
    );
    const client = new RostrumPoolClient({
      network: 'chipnet',
      endpoint: { host: 'rostrum.example', port: 443 },
      socketFactory: (endpoint) => new FakeSocket(server, endpoint.host, endpoint.port),
    });
    await client.connect();
    return { server, client };
  };

  it('returns the initial pool set with exact amounts', async () => {
    const { client } = await setup();
    const pools = await client.subscribe(TOKEN);
    expect(pools).toEqual([
      {
        utxoHash: 'a1'.repeat(32),
        txid: 'b1'.repeat(32),
        vout: 0,
        ownerPkh: 'a10dd0bc10a32b9ce10c8285a8bcaf586d00a140',
        tokenId: TOKEN,
        sats: 150_291_010n,
        tokens: 29_909n,
      },
    ]);
    await client.close();
  });

  it('adds new UTXOs before removing spent ones, so a chain of trades in one update keeps the tip', async () => {
    // #given a subscribed token
    const { server, client } = await setup();
    await client.subscribe(TOKEN);
    const snapshots: (readonly RostrumPool[])[] = [];
    client.onChange((_token, pools) => snapshots.push(pools));
    // #when an update lists trade 2 (spending trade 1's output) before trade 1 (spending the original)
    server.notify('cauldron.contract.subscribe', {
      type: 'update',
      utxos: [
        utxo({
          spent_utxo_hash: 'a2'.repeat(32),
          new_utxo_hash: 'a3'.repeat(32),
          new_utxo_txid: 'b3'.repeat(32),
          new_utxo_n: 0,
        }),
        utxo({
          spent_utxo_hash: 'a1'.repeat(32),
          new_utxo_hash: 'a2'.repeat(32),
          new_utxo_txid: 'b2'.repeat(32),
          new_utxo_n: 0,
        }),
      ],
    });
    await waitFor(() => snapshots.length === 1);
    // #then only the newest pool UTXO remains
    expect(snapshots[0]?.map((pool) => pool.utxoHash)).toEqual(['a3'.repeat(32)]);
    await client.close();
  });

  it('drops a withdrawn pool', async () => {
    const { server, client } = await setup();
    await client.subscribe(TOKEN);
    server.notify('cauldron.contract.subscribe', [
      { type: 'update', utxos: [utxo({ is_withdrawn: true, spent_utxo_hash: 'a1'.repeat(32) })] },
    ]);
    await waitFor(() => client.poolsOf(TOKEN).length === 0);
    expect(client.lastUpdateAt(TOKEN)).toBeTypeOf('number');
    await client.close();
  });

  it('refuses a Rostrum server on another network', async () => {
    const server = new FakeElectrumServer('rostrum.example', CHAIN_NETWORKS.mainnet.genesisHash, '1.4.3');
    const client = new RostrumPoolClient({
      network: 'chipnet',
      endpoint: { host: 'rostrum.example', port: 443 },
      socketFactory: (endpoint) => new FakeSocket(server, endpoint.host, endpoint.port),
    });
    await expect(client.connect()).rejects.toMatchObject({ reason: 'genesis_mismatch' });
  });
});

describe('CauldronIndexerClient', () => {
  it('reads active pools with integers beyond 2^53 kept exact', async () => {
    const seen: { url?: string } = {};
    const body = `{"active":[{"owner_p2pkh_addr":"bitcoincash:zz","owner_pkh":"a10dd0bc10a32b9ce10c8285a8bcaf586d00a140","pool_id":"${'c'.repeat(64)}","sats":150291010,"token_id":"${TOKEN}","tokens":9007199254740993,"tx_pos":1,"txid":"${'d'.repeat(64)}"}]}`;
    const client = new CauldronIndexerClient({ network: 'chipnet', fetch: fakeFetch(200, body, seen) });
    const pools = await client.activePools(TOKEN);
    expect(seen.url).toBe(`https://indexer-chipnet.riften.net/cauldron/pool/active?token=${TOKEN}`);
    expect(pools).toEqual([
      {
        poolId: 'c'.repeat(64),
        ownerPkh: 'a10dd0bc10a32b9ce10c8285a8bcaf586d00a140',
        tokenId: TOKEN,
        txid: 'd'.repeat(64),
        vout: 1,
        sats: 150_291_010n,
        tokens: 9_007_199_254_740_993n,
      },
    ]);
  });

  it('names an HTTP failure and a malformed body', async () => {
    await expect(
      new CauldronIndexerClient({ network: 'chipnet', fetch: fakeFetch(502, '') }).activePools(TOKEN),
    ).rejects.toMatchObject({
      reason: 'request_failed',
    });
    await expect(
      new CauldronIndexerClient({
        network: 'chipnet',
        fetch: fakeFetch(200, '{"active":[{"sats":1}]}'),
      }).activePools(TOKEN),
    ).rejects.toMatchObject({ reason: 'response_invalid' });
  });

  it('keeps strings, escapes, decimals and negatives intact in the exact-integer parser', () => {
    expect(parseJsonWithExactIntegers('{"a":"x\\"1","b":[1.5,-2,3e2],"c":12345678901234567890}')).toEqual({
      a: 'x"1',
      b: [1.5, '-2', 300],
      c: '12345678901234567890',
    });
  });
});

describe('CauldronBroadcastClient', () => {
  it('posts {tx} and returns the txid', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = new CauldronBroadcastClient({
      url: 'https://broadcast.example/broadcast',
      fetch: fakeFetch(200, `{"txid":"${'e'.repeat(64)}"}`, seen),
    });
    expect(await client.broadcast('0200')).toBe('e'.repeat(64));
    expect(seen.init?.method).toBe('POST');
    expect(seen.init?.body).toBe('{"tx":"0200"}');
  });

  it('throws BroadcastRejectedError with the endpoint code', async () => {
    const client = new CauldronBroadcastClient({
      url: 'https://b.example',
      fetch: fakeFetch(400, '{"error":{"code":"REJECTED"}}'),
    });
    const error = await client.broadcast('00').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BroadcastRejectedError);
    expect((error as BroadcastRejectedError).detail).toBe('REJECTED');
  });

  it('exists for mainnet only, where Riften documents an endpoint', () => {
    expect(CauldronBroadcastClient.forNetwork('chipnet')).toBeNull();
    expect(CauldronBroadcastClient.forNetwork('mainnet')).toBeInstanceOf(CauldronBroadcastClient);
  });
});

describe('networks, rejections and explorers', () => {
  it('parses an Electrum override list and names a bad entry', () => {
    expect(parseElectrumEndpoints('a.example:50002, b.example:64002', 'tls')).toEqual([
      { host: 'a.example', port: 50002, transport: 'tls' },
      { host: 'b.example', port: 64002, transport: 'tls' },
    ]);
    expect(() => parseElectrumEndpoints('a.example', 'tls')).toThrow(ElectrumEndpointParseError);
    expect(() => parseElectrumEndpoints('a.example:99999', 'tls')).toThrow(ElectrumEndpointParseError);
  });

  it('classifies node rejection texts', () => {
    expect(
      isSpentInputRejection(
        'the transaction was rejected by network rules.\n\nbad-txns-inputs-missingorspent',
      ),
    ).toBe(true);
    expect(isSpentInputRejection('txn-mempool-conflict (code 18)')).toBe(true);
    expect(isAlreadyKnownRejection('txn-already-known')).toBe(true);
    expect(isSpentInputRejection('mandatory-script-verify-flag-failed')).toBe(false);
  });

  it('builds the verified explorer deep links per network', () => {
    expect(explorerLinks('chipnet').transaction('ab')).toBe('https://chipnet.imaginary.cash/tx/ab');
    expect(explorerLinks('mainnet').address('bitcoincash:qq')).toBe(
      'https://explorer.selene.cash/address/bitcoincash:qq?network=mainnet',
    );
  });
});
