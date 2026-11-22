import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { ElectrumEndpoint } from '@atprice/chain';
import { IndependentConnection, type EvaluatorConnectionChain } from '../../src/health/connection.js';

const tls = (host: string): ElectrumEndpoint => ({ host, port: 50002, transport: 'tls' });
const ENDPOINTS = [tls('a.example'), tls('b.example'), tls('c.example')];

/** A connection that lands on the first host of the list it was built with. */
const recordingFactory = () => {
  const built: string[][] = [];
  const closed: string[] = [];
  const create = (endpoints: readonly ElectrumEndpoint[]): EvaluatorConnectionChain => {
    built.push(endpoints.map((endpoint) => endpoint.host));
    const host = endpoints[0]?.host ?? 'none';
    return {
      endpoint: { host },
      connect: async () => undefined,
      close: async () => {
        closed.push(host);
      },
      getTip: async () => ({ height: 1, hash: '00'.repeat(32), hex: '00'.repeat(80) }),
      getUtxos: async () => [],
    };
  };
  return { built, closed, create };
};

describe('IndependentConnection', () => {
  it('starts from the second server, since the keeper starts from the first', () => {
    const factory = recordingFactory();
    const connection = new IndependentConnection(ENDPOINTS, factory.create, pino({ level: 'silent' }));
    expect(connection.host).toBe('b.example');
    expect(factory.built).toEqual([['b.example', 'c.example', 'a.example']]);
  });

  it('stays put while the keeper reads another server', async () => {
    const factory = recordingFactory();
    const connection = new IndependentConnection(ENDPOINTS, factory.create, pino({ level: 'silent' }));
    expect(await connection.ensureAwayFrom('a.example')).toBe(false);
    expect(await connection.ensureAwayFrom(undefined)).toBe(false);
    expect(factory.built).toHaveLength(1);
  });

  it("reconnects with the keeper's host last when both land on one server", async () => {
    // #given the keeper failed over onto the evaluator's server
    const factory = recordingFactory();
    const connection = new IndependentConnection(ENDPOINTS, factory.create, pino({ level: 'silent' }));
    // #when
    const moved = await connection.ensureAwayFrom('B.example');
    // #then
    expect(moved).toBe(true);
    expect(factory.closed).toEqual(['b.example']);
    expect(factory.built.at(-1)).toEqual(['a.example', 'c.example', 'b.example']);
    expect(connection.host).toBe('a.example');
  });

  it('cannot move when every endpoint is the keeper host, and leaves the judge to report it', async () => {
    const factory = recordingFactory();
    const connection = new IndependentConnection(
      [tls('only.example'), tls('only.example')],
      factory.create,
      pino({ level: 'silent' }),
    );
    expect(await connection.ensureAwayFrom('only.example')).toBe(false);
    expect(connection.host).toBe('only.example');
  });
});
