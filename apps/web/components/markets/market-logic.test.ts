import { describe, expect, it } from 'vitest';
import { evidenceOrder } from '@/components/evidence/evidence.fixtures';
import type { MarketSummary } from '@/lib/api/schemas';
import {
  activityAmounts,
  availabilityOf,
  changeOf,
  identityOf,
  latestObservation,
  marketActivity,
  nextSort,
  parseSort,
  shortSymbol,
  sortCaption,
  sortMarkets,
  sourceHosts,
} from './market-logic';

const market = (overrides: Partial<MarketSummary>): MarketSummary => ({
  slug: 'bch-x',
  tokenId: 'aa'.repeat(32),
  symbol: 'X',
  name: 'X token',
  decimals: 2,
  verified: true,
  spotRate: { value: { numerator: 221n, denominator: 1n } },
  change24h: { value: null, reason: 'less than 24 hours of observations' },
  liquidity: { sats: 1_000_000n, tokens: 100n },
  poolCount: 1,
  volume24h: { value: null, reason: 'Cauldron indexer does not report volume' },
  availability: 'open',
  availabilityReason: null,
  minOrder: { buy: 50_000n, sell: 10n },
  observedAt: '2026-11-22T14:02:11.000Z',
  blockHeight: 925_114,
  ...overrides,
});

describe('market sort (markets.md "Controls")', () => {
  it('reads the sort from the URL and falls back to liquidity, descending', () => {
    expect(parseSort(null, null)).toEqual({ key: 'liquidity', dir: 'desc' });
    expect(parseSort('pair', null)).toEqual({ key: 'pair', dir: 'asc' });
    expect(parseSort('change', 'asc')).toEqual({ key: 'change', dir: 'asc' });
    expect(parseSort('rate', 'sideways')).toEqual({ key: 'liquidity', dir: 'desc' });
  });

  it('flips the active column and starts a new one in its natural direction', () => {
    expect(nextSort({ key: 'liquidity', dir: 'desc' }, 'liquidity')).toEqual({
      key: 'liquidity',
      dir: 'asc',
    });
    expect(nextSort({ key: 'liquidity', dir: 'desc' }, 'pair')).toEqual({ key: 'pair', dir: 'asc' });
  });

  it('describes the order in the table caption', () => {
    expect(sortCaption({ key: 'liquidity', dir: 'desc' })).toBe(
      'Markets on AtPrice, sorted by liquidity, descending',
    );
  });

  it('puts a null 24h change last in both directions', () => {
    const up = market({ symbol: 'UP', change24h: { value: { numerator: 42n, denominator: 10_000n } } });
    const down = market({ symbol: 'DOWN', change24h: { value: { numerator: -5n, denominator: 1_000n } } });
    const none = market({ symbol: 'NONE' });
    expect(sortMarkets([none, down, up], { key: 'change', dir: 'desc' }).map((m) => m.symbol)).toEqual([
      'UP',
      'DOWN',
      'NONE',
    ]);
    expect(sortMarkets([none, up, down], { key: 'change', dir: 'asc' }).map((m) => m.symbol)).toEqual([
      'DOWN',
      'UP',
      'NONE',
    ]);
  });
});

describe('market values', () => {
  it('says the 24h change in words and never shows a missing one as zero', () => {
    expect(changeOf({ value: { numerator: 42n, denominator: 10_000n } })).toEqual({
      direction: 'up',
      text: '+0.42%',
      spoken: 'up 0.42 percent in 24 hours',
    });
    expect(changeOf({ value: null, reason: 'less than 24 hours of observations' })).toEqual({
      direction: 'none',
      text: '24h change not yet',
      spoken: '24 hour change not available: less than 24 hours of observations',
    });
  });

  it('pauses every market on a network mismatch', () => {
    expect(availabilityOf(market({}), true)).toEqual({
      availability: 'paused',
      label: 'Paused',
      reason: 'Network mismatch',
    });
    expect(
      availabilityOf(market({ availability: 'paused', availabilityReason: 'pool data stale' }), false),
    ).toEqual({
      availability: 'paused',
      label: 'Paused',
      reason: 'pool data stale',
    });
  });

  it('truncates long symbols at 12 characters', () => {
    expect(shortSymbol('ABCDEFGHIJKLMNOP')).toBe('ABCDEFGHIJKL…');
    expect(shortSymbol('PUSD')).toBe('PUSD');
  });

  it('finds the latest observation and formats ages in whole units', () => {
    expect(
      latestObservation([
        market({ observedAt: null }),
        market({ observedAt: '2026-11-22T14:00:00.000Z', blockHeight: 7 }),
      ]),
    ).toEqual({ observedAt: '2026-11-22T14:00:00.000Z', blockHeight: 7 });
  });
});

describe('market identity and activity', () => {
  it('takes token identity from the bundled allowlist over the API', () => {
    const identity = identityOf(
      market({
        tokenId: 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
        symbol: 'WRONG',
        decimals: 8,
      }),
    );
    expect(identity).toMatchObject({ symbol: 'PUSDTEST', decimals: 2 });
    expect(sourceHosts(identity.sources)).toEqual(['indexer-chipnet.riften.net']);
  });

  it('lists each completed order as its settlement and funding, newest first, for this token only', () => {
    const order = evidenceOrder({
      fundingBlock: { height: 1, time: '2026-11-22T13:00:00.000Z' },
      settlementBlock: { height: 2, time: '2026-11-22T13:58:00.000Z' },
    });
    const elsewhere = evidenceOrder({ tokenCategory: 'bb'.repeat(32) });
    const rows = marketActivity([order, elsewhere], order.tokenCategory);
    expect(rows.map((row) => row.kind)).toEqual(['Fill', 'Funding']);
    const [latest] = rows;
    expect(latest === undefined ? null : activityAmounts(latest)).toEqual({
      from: 'Buy 0.05 BCH',
      to: '22.61 PUSDTEST',
    });
  });
});
