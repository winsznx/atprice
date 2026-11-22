import { describe, expect, it } from 'vitest';
import { reviewGate, UNREACHABLE_REASON, type ReviewInputs } from './review-rules';

const ready: ReviewInputs = {
  wallet: { kind: 'connected' },
  networkMismatch: null,
  market: { kind: 'ok' },
  staleForMs: null,
  balance: { kind: 'ok' },
  amount: { kind: 'ok' },
  belowMinimum: null,
  limit: { kind: 'ok' },
  recipient: { kind: 'ok' },
  side: 'buy',
  symbol: 'PUSD',
  tokenDecimals: 2,
};

describe('reviewGate (DD 7.2 order)', () => {
  it('is ready when every check passes', () => {
    expect(reviewGate(ready)).toEqual({ kind: 'ready' });
  });

  it('reads Connect wallet with no wallet and still prints a paused market', () => {
    expect(
      reviewGate({
        ...ready,
        wallet: { kind: 'none' },
        market: { kind: 'paused', reason: 'pool data stale' },
      }),
    ).toEqual({ kind: 'connect', reason: 'Orders are paused for this market: pool data stale.' });
  });

  it('puts the network mismatch before every wallet condition', () => {
    const gate = reviewGate({
      ...ready,
      networkMismatch: { web: 'chipnet', api: 'mainnet' },
      wallet: { kind: 'reconnecting', elapsedMs: 3_000 },
    });
    expect(gate).toEqual({
      kind: 'blocked',
      reason:
        'AtPrice is misconfigured: this page is on chipnet but the server is on mainnet. Orders are paused.',
      field: null,
    });
  });

  it('names the reconnect with its elapsed time', () => {
    expect(reviewGate({ ...ready, wallet: { kind: 'reconnecting', elapsedMs: 12_000 } })).toMatchObject({
      reason: 'Reconnecting to your wallet (0:12). Requests resume when it answers.',
    });
  });

  it('puts the wrong wallet network before the API state', () => {
    expect(
      reviewGate({
        ...ready,
        wallet: { kind: 'wrong_network', walletNetwork: 'a test network', appNetwork: 'mainnet' },
        market: { kind: 'unreachable' },
      }),
    ).toMatchObject({ reason: 'Your wallet is on a test network. Switch it to mainnet to place orders.' });
  });

  it('blocks with the unreachable text when the API is down', () => {
    expect(reviewGate({ ...ready, market: { kind: 'unreachable' } })).toMatchObject({
      reason: UNREACHABLE_REASON,
    });
  });

  it('blocks a stale quote with its age', () => {
    expect(reviewGate({ ...ready, staleForMs: 75_000 })).toMatchObject({
      reason: 'Pool data is out of date (last update 1:15 ago). Orders resume when fresh data arrives.',
    });
  });

  it('puts an unknown balance before an empty amount', () => {
    expect(
      reviewGate({
        ...ready,
        balance: { kind: 'unknown', code: 'ELECTRUM_UNREACHABLE' },
        amount: { kind: 'empty' },
      }),
    ).toMatchObject({ reason: 'Balance unknown, so the order can’t be built (ELECTRUM_UNREACHABLE).' });
  });

  it('points an empty amount at the amount field', () => {
    expect(reviewGate({ ...ready, amount: { kind: 'empty' } })).toEqual({
      kind: 'blocked',
      reason: 'Enter an amount.',
      field: 'amount',
    });
  });

  it('states the minimum order in the side’s unit', () => {
    expect(reviewGate({ ...ready, belowMinimum: { minimum: 50_000n } })).toMatchObject({
      reason: 'The minimum order is 0.0005 BCH, so fees stay a small share of it.',
    });
  });

  it('explains what a buy needs when BCH is short', () => {
    expect(
      reviewGate({
        ...ready,
        balance: { kind: 'bch_short', side: 'buy', balance: 50_000_000n, needed: 50_004_312n },
      }),
    ).toMatchObject({
      reason:
        'You have 0.50 BCH. This order needs 0.50004312 BCH: the order, the network fee cap, token dust, the funding fee, and at least 1,000 sat kept at your owner address for a later cancel.',
    });
  });

  it('compares token balance with the amount sold', () => {
    expect(
      reviewGate({
        ...ready,
        side: 'sell',
        balance: { kind: 'tokens_short', balance: 100_000n, amount: 125_000n },
      }),
    ).toMatchObject({ reason: 'You have 1,000.00 PUSD. This order sells 1,250.00 PUSD.' });
  });

  it('puts a short balance before an empty limit', () => {
    expect(
      reviewGate({
        ...ready,
        limit: { kind: 'empty' },
        balance: { kind: 'tokens_short', balance: 1n, amount: 2n },
      }),
    ).toMatchObject({ field: 'amount' });
  });

  it('asks for a limit above zero', () => {
    expect(reviewGate({ ...ready, limit: { kind: 'empty' } })).toMatchObject({
      reason: 'Enter a limit price above zero.',
      field: 'limit',
    });
  });

  it('ends with the recipient', () => {
    expect(reviewGate({ ...ready, recipient: { kind: 'invalid', message: 'x' } })).toMatchObject({
      reason: 'Fix the recipient address.',
      field: 'recipient',
    });
  });
});
