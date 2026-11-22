import { describe, expect, it } from 'vitest';
import {
  buyFill,
  buyMinOut,
  cauldronTradeFee,
  InvalidOrderParamsError,
  QuoteError,
  satisfiesCauldronExchange,
  sellFill,
  sellMinOut,
  sellMinOutFromNetProceeds,
  sellNetProceedsFromMinOut,
  type PoolReserves,
} from '../src/index.js';
import { cashlabPool, exchangeLab } from './support/cashlab.js';
import { CATEGORY, POOL_OWNER } from './support/fixtures.js';
import { Random } from './support/random.js';

const PROPERTY_CASES = 2000;
const CHIPNET_POOL: PoolReserves = { sats: 150_545_039n, tokens: 29_857n };

const randomPool = (random: Random): PoolReserves => ({
  sats: random.logScale(17, 60),
  tokens: random.logScale(4, 62),
});

/** The contract's buy best-fill check: one token more for the same BCH breaks the pool rule. */
const buyIsTight = (before: PoolReserves, after: PoolReserves): boolean => {
  const poolFee = cauldronTradeFee(after.sats - before.sats);
  return (after.sats - poolFee) * (after.tokens - 1n) < before.sats * before.tokens;
};

/** The contract's sell best-fill check: one satoshi more out breaks the pool rule. */
const sellIsTight = (before: PoolReserves, after: PoolReserves): boolean => {
  const w = before.sats - after.sats + 1n;
  return (after.sats - 1n - (w * 3n) / 1000n) * after.tokens < before.sats * before.tokens;
};

describe('reference vectors (research/cauldron.md, chipnet pool 150,545,039 sats / 29,857 tokens)', () => {
  it('buys 1,854 tokens for 10,000,000 or 9,997,156 sats and 1,853 for 9,997,155', () => {
    expect(buyFill(CHIPNET_POOL, 10_000_000n).tokensOut).toBe(1854n);
    expect(buyFill(CHIPNET_POOL, 9_997_156n).tokensOut).toBe(1854n);
    expect(buyFill(CHIPNET_POOL, 9_997_155n).tokensOut).toBe(1853n);
  });

  it('sells 1,000 tokens for 4,864,204 sats', () => {
    const fill = sellFill(CHIPNET_POOL, 1000n);
    expect(fill.bchOut).toBe(4_864_204n);
    expect(fill.poolFee).toBe(14_592n);
    expect(fill.poolAfter).toEqual({ sats: CHIPNET_POOL.sats - 4_864_204n, tokens: 30_857n });
  });
});

describe('buyFill', () => {
  it(`matches @cashlab/cauldron ExchangeLab on ${PROPERTY_CASES} random single-pool buys`, () => {
    const random = new Random(0xb0b1n);
    let compared = 0;
    while (compared < PROPERTY_CASES) {
      const pool = randomPool(random);
      const bchIn = random.between(1n, pool.sats * 4n);
      const fill = buyFill(pool, bchIn);
      if (fill.tokensOut === 0n) continue;
      const trade = exchangeLab.constructTradeBestRateForTargetSupply(
        'BCH',
        CATEGORY,
        bchIn,
        [cashlabPool(POOL_OWNER.pkh, CATEGORY, pool)],
        0n,
      );
      expect(trade.entries.map((entry) => entry.demand)).toEqual([fill.tokensOut]);
      compared += 1;
    }
  });

  it(`satisfies the Cauldron predicate and the contract's best-fill check on ${PROPERTY_CASES} random cases`, () => {
    const random = new Random(0xb0b2n);
    for (let index = 0; index < PROPERTY_CASES; index += 1) {
      const pool = randomPool(random);
      const fill = buyFill(pool, random.logScale(1, 64));
      expect(fill.poolAfter.sats).toBe(pool.sats + fill.bchIn);
      expect(fill.poolAfter.tokens + fill.tokensOut).toBe(pool.tokens);
      expect(fill.poolAfter.tokens).toBeGreaterThanOrEqual(1n);
      expect(satisfiesCauldronExchange(pool, fill.poolAfter)).toBe(true);
      expect(satisfiesCauldronExchange(pool, { ...fill.poolAfter, tokens: fill.poolAfter.tokens - 1n })).toBe(
        false,
      );
      expect(buyIsTight(pool, fill.poolAfter)).toBe(true);
    }
  });

  it('is monotonic in bchIn', () => {
    const random = new Random(0xb0b3n);
    for (let index = 0; index < PROPERTY_CASES; index += 1) {
      const pool = randomPool(random);
      const bchIn = random.logScale(1, 50);
      expect(buyFill(pool, bchIn + 1n).tokensOut).toBeGreaterThanOrEqual(buyFill(pool, bchIn).tokensOut);
    }
  });

  it('stays exact when B0*T0 exceeds 2^100', () => {
    const pool = { sats: 2n ** 52n + 12_345n, tokens: 2n ** 62n - 7n };
    expect(pool.sats * pool.tokens > 2n ** 100n).toBe(true);
    const fill = buyFill(pool, 123_456_789_012n);
    expect(satisfiesCauldronExchange(pool, fill.poolAfter)).toBe(true);
    expect(buyIsTight(pool, fill.poolAfter)).toBe(true);
  });

  it('rejects empty pools and non-positive input', () => {
    expect(() => buyFill({ sats: 0n, tokens: 5n }, 1n)).toThrow(QuoteError);
    expect(() => buyFill(CHIPNET_POOL, 0n)).toThrow(QuoteError);
  });
});

describe('sellFill', () => {
  it(`matches @cashlab/cauldron ExchangeLab on ${PROPERTY_CASES} random single-pool sells`, () => {
    const random = new Random(0x5e11n);
    let compared = 0;
    while (compared < PROPERTY_CASES) {
      const pool = randomPool(random);
      const tokensIn = random.between(1n, pool.tokens);
      const fill = sellFill(pool, tokensIn);
      if (fill.bchOut === 0n) continue;
      const trade = exchangeLab.constructTradeBestRateForTargetSupply(
        CATEGORY,
        'BCH',
        tokensIn,
        [cashlabPool(POOL_OWNER.pkh, CATEGORY, pool)],
        0n,
      );
      expect(trade.entries.map((entry) => entry.demand)).toEqual([fill.bchOut]);
      compared += 1;
    }
  });

  it(`satisfies the Cauldron predicate and the contract's best-fill check on ${PROPERTY_CASES} random cases`, () => {
    const random = new Random(0x5e12n);
    for (let index = 0; index < PROPERTY_CASES; index += 1) {
      const pool = randomPool(random);
      const fill = sellFill(pool, random.logScale(1, 63));
      expect(fill.poolAfter.tokens).toBe(pool.tokens + fill.tokensIn);
      expect(fill.poolAfter.sats + fill.bchOut).toBe(pool.sats);
      expect(fill.poolFee).toBe(cauldronTradeFee(fill.bchOut));
      expect(satisfiesCauldronExchange(pool, fill.poolAfter)).toBe(true);
      expect(satisfiesCauldronExchange(pool, { ...fill.poolAfter, sats: fill.poolAfter.sats - 1n })).toBe(
        false,
      );
      expect(sellIsTight(pool, fill.poolAfter)).toBe(true);
    }
  });

  it('matches an exhaustive search on small pools', () => {
    const random = new Random(0x5e13n);
    for (let index = 0; index < PROPERTY_CASES; index += 1) {
      const pool = { sats: random.between(1n, 5000n), tokens: random.between(1n, 300n) };
      const tokensIn = random.between(1n, 300n);
      let best = 0n;
      for (let out = 1n; out < pool.sats; out += 1n) {
        if (satisfiesCauldronExchange(pool, { sats: pool.sats - out, tokens: pool.tokens + tokensIn }))
          best = out;
      }
      expect(sellFill(pool, tokensIn).bchOut).toBe(best);
    }
  });

  it('is monotonic in tokensIn', () => {
    const random = new Random(0x5e14n);
    for (let index = 0; index < PROPERTY_CASES; index += 1) {
      const pool = randomPool(random);
      const tokensIn = random.logScale(1, 50);
      expect(sellFill(pool, tokensIn + 1n).bchOut).toBeGreaterThanOrEqual(sellFill(pool, tokensIn).bchOut);
    }
  });

  it('stays exact when B0*T0 exceeds 2^100', () => {
    const pool = { sats: 2n ** 50n + 99n, tokens: 2n ** 62n - 3n };
    const fill = sellFill(pool, 2n ** 40n);
    expect(satisfiesCauldronExchange(pool, fill.poolAfter)).toBe(true);
    expect(sellIsTight(pool, fill.poolAfter)).toBe(true);
  });

  it('rejects non-positive input', () => {
    expect(() => sellFill(CHIPNET_POOL, 0n)).toThrow(QuoteError);
  });
});

describe('minOut from a limit price', () => {
  it('buy minOut is the smallest token amount at or under the max price', () => {
    expect(buyMinOut(10_000n, { numerator: 3n, denominator: 1n })).toBe(3334n);
    expect(buyMinOut(9_999n, { numerator: 3n, denominator: 1n })).toBe(3333n);
    expect(buyMinOut(1_000_000n, { numerator: 5n, denominator: 2n })).toBe(400_000n);
    const random = new Random(0x1171n);
    for (let index = 0; index < PROPERTY_CASES; index += 1) {
      const spend = random.logScale(1, 50);
      const price = { numerator: random.logScale(1, 40), denominator: random.logScale(1, 40) };
      const minOut = buyMinOut(spend, price);
      expect(spend * price.denominator <= minOut * price.numerator).toBe(true);
      expect(spend * price.denominator > (minOut - 1n) * price.numerator).toBe(true);
    }
  });

  it('sell minOut is the net proceeds at the min price plus the order 2000 sats', () => {
    expect(sellMinOut(1000n, { numerator: 4864n, denominator: 1n })).toEqual({
      netProceeds: 4_864_000n,
      minOut: 4_866_000n,
    });
    expect(sellMinOut(3n, { numerator: 1n, denominator: 2n })).toEqual({ netProceeds: 2n, minOut: 2002n });
    expect(sellMinOutFromNetProceeds(1n)).toEqual({ netProceeds: 1n, minOut: 2001n });
    expect(sellNetProceedsFromMinOut(2001n)).toBe(1n);
    const random = new Random(0x1172n);
    for (let index = 0; index < PROPERTY_CASES; index += 1) {
      const tokens = random.logScale(1, 50);
      const price = { numerator: random.logScale(1, 40), denominator: random.logScale(1, 40) };
      const { netProceeds, minOut } = sellMinOut(tokens, price);
      expect(minOut - netProceeds).toBe(2000n);
      expect(netProceeds * price.denominator >= tokens * price.numerator).toBe(true);
      expect((netProceeds - 1n) * price.denominator < tokens * price.numerator).toBe(true);
    }
  });

  it('rejects zero or negative prices and amounts', () => {
    expect(() => buyMinOut(1n, { numerator: 0n, denominator: 1n })).toThrow(InvalidOrderParamsError);
    expect(() => buyMinOut(0n, { numerator: 1n, denominator: 1n })).toThrow(InvalidOrderParamsError);
    expect(() => sellMinOut(1n, { numerator: 1n, denominator: -1n })).toThrow(InvalidOrderParamsError);
    expect(() => sellMinOutFromNetProceeds(0n)).toThrow(InvalidOrderParamsError);
  });
});
