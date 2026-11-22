import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { ApiError } from './errors';

const NETWORK = {
  network: 'chipnet',
  genesisHash: '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b',
  tip: null,
  feeRateSatsPerByte: '1',
  protocolFeeBps: 0,
};

const respond = (status: number, body: unknown) =>
  vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

const failure = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError');
};

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('parses a valid response into typed values with bigint amounts', async () => {
    const fetchMock = respond(200, NETWORK);
    vi.stubGlobal('fetch', fetchMock);
    const result = await api.network();
    expect(result.feeRateSatsPerByte).toBe(1n);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4000/api/v1/network');
  });

  it('names a schema mismatch API_RESPONSE_INVALID', async () => {
    vi.stubGlobal('fetch', respond(200, { ...NETWORK, feeRateSatsPerByte: 1 }));
    const error = await failure(api.network());
    expect(error.code).toBe('API_RESPONSE_INVALID');
    expect(error.message).toContain('feeRateSatsPerByte');
  });

  it('carries the server reason of an error envelope', async () => {
    vi.stubGlobal('fetch', respond(429, { error: 'intent_capacity', message: 'too many open intents' }));
    const error = await failure(api.registerOrder('a'.repeat(64)));
    expect(error.code).toBe('API_ERROR');
    expect(error.status).toBe(429);
    expect(error.serverCode).toBe('intent_capacity');
    expect(error.displayCode).toBe('intent_capacity');
    expect(error.message).toBe('too many open intents');
  });

  it('names a failed request API_UNREACHABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect((await failure(api.network())).code).toBe('API_UNREACHABLE');
  });

  it('treats a 503 health answer as data, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      respond(503, {
        status: 'degraded',
        checkedAt: '2026-11-22T10:00:00.000Z',
        reasons: ['sweep_stale'],
        sweepIntervalMs: 30000,
        lastSweepFinishedAt: null,
      }),
    );
    const health = await api.health();
    expect(health.status).toBe('degraded');
    expect(health.reasons).toEqual(['sweep_stale']);
  });

  it('sends intent amounts as decimal strings', async () => {
    const fetchMock = respond(201, {
      intentId: 'i1',
      orderAddress: 'bchtest:pexample',
      expiresAt: '2026-11-23T10:00:00.000Z',
    });
    vi.stubGlobal('fetch', fetchMock);
    await api.createIntent({
      side: 'buy',
      ownerPkh: '00'.repeat(20),
      recipientLockingBytecode: '76a914' + '00'.repeat(20) + '88ac',
      tokenCategory: 'ab'.repeat(32),
      amount: 9_007_199_254_740_993n,
      minOut: 1n,
      maxNetworkFee: 2000n,
      nonce: '01'.repeat(8),
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      amount: '9007199254740993',
      maxNetworkFee: '2000',
    });
  });
});
