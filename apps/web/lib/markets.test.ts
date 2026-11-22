import { SUPPORTED_MARKETS } from '@atprice/core';
import { describe, expect, it } from 'vitest';
import type { MarketSummary } from './api/schemas';
import { defaultMarket, firstListedOpenMarket } from './markets';

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
  it('picks the first open, verified market in the allowlist order, not the deepest one', () => {
    // #given PUSD is listed before RES on mainnet, and RES has more BCH liquidity
    const [pusd, res] = SUPPORTED_MARKETS.mainnet;
    if (pusd === undefined || res === undefined) throw new Error('mainnet allowlist changed');
    const deepRes = market({
      symbol: res.symbol,
      tokenId: res.tokenCategory,
      liquidity: { sats: 99_000_000_000n, tokens: 1n },
    });
    const shallowPusd = market({
      symbol: pusd.symbol,
      tokenId: pusd.tokenCategory,
      liquidity: { sats: 1_000_000n, tokens: 1n },
    });
    // #when
    const chosen = firstListedOpenMarket([deepRes, shallowPusd], SUPPORTED_MARKETS.mainnet);
    // #then
    expect(chosen?.symbol).toBe(pusd.symbol);
  });

  it('skips markets that are not open, not verified or not bundled', () => {
    // #given only the bundled, open, verified market qualifies
    const thin = market({ symbol: 'THIN', availability: 'low_liquidity' });
    const unverified = market({ symbol: 'UNVERIFIED', verified: false });
    const foreign = market({ symbol: 'FOREIGN', tokenId: 'ab'.repeat(32) });
    const ok = market({ symbol: 'OK' });
    // #when
    const chosen = defaultMarket([thin, unverified, foreign, ok]);
    // #then
    expect(chosen?.symbol).toBe('OK');
  });

  it('has no default when nothing is open', () => {
    expect(
      defaultMarket([market({ availability: 'low_liquidity' }), market({ availability: 'paused' })]),
    ).toBeUndefined();
    expect(defaultMarket([])).toBeUndefined();
  });
});
