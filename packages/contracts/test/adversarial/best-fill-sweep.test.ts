import { describe, expect, it } from 'vitest';
import { buyFill, satisfiesCauldronExchange, sellFill, type PoolReserves } from '@atprice/core';
import { CATEGORY, Chain, orderParams } from '../harness.js';
import { evaluateInput, expectCovenantRejects, rawBuy, rawSell, verifyAll } from './support.js';

/** Deterministic 64-bit xorshift, so a failing case can be replayed from its index. */
const prng = (seed: bigint) => {
  let state = seed;
  const next = (): bigint => {
    state ^= (state << 13n) & 0xffff_ffff_ffff_ffffn;
    state ^= state >> 7n;
    state ^= (state << 17n) & 0xffff_ffff_ffff_ffffn;
    return state;
  };
  /** Log-uniform integer in [low, high], so small and huge magnitudes are both exercised. */
  return (low: bigint, high: bigint): bigint => {
    const bits = BigInt(high.toString(2).length);
    const lowBits = BigInt(low.toString(2).length);
    const width = lowBits + (next() % (bits - lowBits + 1n));
    const value = next() % (1n << width);
    return value < low ? low : value > high ? high : value;
  };
};

const SWEEP = 40;

interface BuyCase {
  readonly pool: PoolReserves;
  readonly bchIn: bigint;
}

const buyCases = (): BuyCase[] => {
  const draw = prng(0x9e3779b97f4a7c15n);
  const random: BuyCase[] = [];
  while (random.length < SWEEP) {
    const pool = { sats: draw(1_000_000n, 2n ** 50n), tokens: draw(10_000n, 2n ** 62n) };
    const bchIn = draw(1_000n, 2n ** 40n);
    if (buyFill(pool, bchIn).tokensOut >= 2n) random.push({ pool, bchIn });
  }
  // bchIn values where Cauldron's truncated 0.3% fee steps (at 334, 667, 1000, 1334, ...), against a
  // pool cheap enough that every one of them releases tokens.
  const cheap = { sats: 1_000_000n, tokens: 10n ** 15n };
  const steps = [333n, 334n, 335n, 666n, 667n, 668n, 999n, 1000n, 1001n, 1333n, 1334n, 1335n, 333_334n];
  return [...random, ...steps.map((bchIn) => ({ pool: cheap, bchIn }))];
};

interface SellCase {
  readonly pool: PoolReserves;
  readonly tokensIn: bigint;
}

const sellCases = (): SellCase[] => {
  const draw = prng(0xd1b54a32d192ed03n);
  const cases: SellCase[] = [];
  while (cases.length < SWEEP) {
    const pool = { sats: draw(10_000_000n, 2n ** 50n), tokens: draw(10_000n, 2n ** 62n) };
    const tokensIn = draw(1n, pool.tokens);
    // One satoshi short of the best fill must still clear minOut 2001, so bchOut >= 1002.
    if (sellFill(pool, tokensIn).bchOut >= 1002n) cases.push({ pool, tokensIn });
  }
  return cases;
};

describe('adversarial best-fill sweep: AtPriceBuy accepts exactly the best fill (differential vs the pool rule)', () => {
  it.each(buyCases().map((testCase, index) => [index, testCase] as const))(
    'case %i',
    (_index, { pool: reserves, bchIn }) => {
      // #given a pool and an order sized so the default 1000-sat fee leaves exactly bchIn for the pool
      const best = buyFill(reserves, bchIn);
      expect(best.tokensOut >= 2n).toBe(true);
      expect(satisfiesCauldronExchange(reserves, best.poolAfter)).toBe(true);
      const chain = new Chain();
      const pool = chain.addPool(reserves);
      const { order, utxo } = chain.addOrder(orderParams('buy'), { satoshis: bchIn + 2000n });

      // #then the best fill passes the whole standard VM
      const accepted = rawBuy(order, utxo, pool);
      expect(verifyAll(accepted.transaction, accepted.sourceOutputs)).toBe(true);

      // #then one token less is refused by the covenant alone, on the best-fill require
      expectCovenantRejects(
        rawBuy(order, utxo, pool, { tokensOut: best.tokensOut - 1n }),
        order,
        'fill leaves tokens in the pool',
        {
          poolPasses: true,
        },
      );

      // #then one token more is refused by the pool, and the covenant does not object
      const greedy = rawBuy(order, utxo, pool, { tokensOut: best.tokensOut + 1n });
      expect(evaluateInput(greedy.transaction, greedy.sourceOutputs, 0).ok).toBe(false);
      expect(evaluateInput(greedy.transaction, greedy.sourceOutputs, 1, order.contract.artifact)).toEqual({
        ok: true,
      });
    },
  );
});

describe('adversarial best-fill sweep: AtPriceSell accepts exactly the best fill (differential vs the pool rule)', () => {
  it.each(sellCases().map((testCase, index) => [index, testCase] as const))(
    'case %i',
    (_index, { pool: reserves, tokensIn }) => {
      // #given a pool and a sell order whose best fill clears minOut 2001 even one satoshi short
      const best = sellFill(reserves, tokensIn);
      expect(satisfiesCauldronExchange(reserves, best.poolAfter)).toBe(true);
      const chain = new Chain();
      const pool = chain.addPool(reserves);
      const { order, utxo } = chain.addOrder(orderParams('sell'), {
        satoshis: 2000n,
        token: { category: CATEGORY, amount: tokensIn },
      });
      // #then the best fill passes the whole standard VM
      const accepted = rawSell(order, utxo, pool);
      expect(verifyAll(accepted.transaction, accepted.sourceOutputs)).toBe(true);

      // #then one satoshi less out of the pool is refused by the covenant alone
      const short = best.bchOut - 1n;
      expectCovenantRejects(
        rawSell(order, utxo, pool, { bchOut: short, payoutSats: short + 1000n }),
        order,
        'fill leaves BCH in the pool',
        {
          poolPasses: true,
        },
      );

      // #then one satoshi more is refused by the pool, and the covenant does not object
      const greedy = rawSell(order, utxo, pool, {
        bchOut: best.bchOut + 1n,
        payoutSats: best.bchOut + 1001n,
      });
      expect(evaluateInput(greedy.transaction, greedy.sourceOutputs, 0).ok).toBe(false);
      expect(evaluateInput(greedy.transaction, greedy.sourceOutputs, 1, order.contract.artifact)).toEqual({
        ok: true,
      });
    },
  );
});
