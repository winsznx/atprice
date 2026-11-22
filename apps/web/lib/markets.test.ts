import { SUPPORTED_MARKETS } from '@atprice/core';
import { describe, expect, it } from 'vitest';
import type { MarketSummary } from './api/schemas';
import { defaultMarket } from './markets';

const bundled = SUPPORTED_MARKETS.chipnet[0];
if (bundled === undefined) throw new Error('chipnet has no bundled market');

const market = (overrides: Partial<MarketSummary>): MarketSummary => ({
  slug: 'bch-x',
  tokenId: bundled.tokenCategory,
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

describe('default market for / and /trade', () => {
  it('picks the open, verified, bundled market with the most BCH liquidity', () => {
    const big = market({ symbol: 'BIG', liquidity: { sats: 9_000_000n, tokens: 1n } });
    const thin = market({
      symbol: 'THIN',
      availability: 'low_liquidity',
      liquidity: { sats: 99_000_000n, tokens: 1n },
    });
    const unverified = market({
      symbol: 'UNVERIFIED',
      verified: false,
      liquidity: { sats: 99_000_000n, tokens: 1n },
    });
    const foreign = market({
      symbol: 'FOREIGN',
      tokenId: 'ab'.repeat(32),
      liquidity: { sats: 99_000_000n, tokens: 1n },
    });
    const small = market({ symbol: 'SMALL' });
    expect(defaultMarket([small, thin, unverified, foreign, big])?.symbol).toBe('BIG');
  });

  it('has no default when nothing is open', () => {
    expect(
      defaultMarket([market({ availability: 'low_liquidity' }), market({ availability: 'paused' })]),
    ).toBeUndefined();
    expect(defaultMarket([])).toBeUndefined();
  });
});
