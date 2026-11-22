import { hexToBin } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { sellFill, type PoolReserves } from '@atprice/core';
import {
  CATEGORY,
  Chain,
  contractUnlock,
  OTHER_CATEGORY,
  OTHER_POOL_OWNER,
  orderParams,
  OWNER,
  POOL_OWNER,
  poolOutput,
  rawTransaction,
  STRANGER,
  tokenOutput,
} from '../harness.js';
import {
  evaluateInput,
  executeInput,
  expectAcceptedRaw,
  expectCovenantRejects,
  poolInput,
  poolWithdrawUnlock,
  rawSell,
  verifyAll,
} from './support.js';

const POOL: PoolReserves = { sats: 150_545_039n, tokens: 29_857n };
const TOKENS_IN = 1000n;
const MAX_FEE = 2000n;
const BEST = sellFill(POOL, TOKENS_IN);
/** rawSell's default: a 1000-sat miner fee. */
const DEFAULT_PAYOUT = BEST.bchOut + 2000n - 1000n;

const setup = (overrides: Parameters<typeof orderParams>[1] = {}) => {
  const chain = new Chain();
  const pool = chain.addPool(POOL);
  const { order, utxo } = chain.addOrder(orderParams('sell', overrides), {
    satoshis: 2000n,
    token: { category: CATEGORY, amount: TOKENS_IN },
  });
  return { chain, pool, order, utxo };
};

describe('adversarial AtPriceSell.execute: positive controls', () => {
  it('accepts the unmodified hand-built best fill (harness can accept)', async () => {
    const { chain, pool, order, utxo } = setup();
    await expectAcceptedRaw(chain, rawSell(order, utxo, pool));
  });

  it('accepts a miner fee of exactly maxNetworkFee', async () => {
    const { chain, pool, order, utxo } = setup();
    await expectAcceptedRaw(chain, rawSell(order, utxo, pool, { payoutSats: BEST.bchOut + 2000n - MAX_FEE }));
  });

  it('accepts a payout exactly equal to minOut (P + 2000)', async () => {
    const { chain, pool, order, utxo } = setup({ minOut: DEFAULT_PAYOUT });
    await expectAcceptedRaw(chain, rawSell(order, utxo, pool));
  });
});

describe('adversarial AtPriceSell.execute: altered outputs and redirected value', () => {
  it('rejects the payout sent to a stranger', () => {
    const { pool, order, utxo } = setup();
    const payout = { lockingBytecode: STRANGER.lockingBytecode, valueSatoshis: DEFAULT_PAYOUT };
    expectCovenantRejects(rawSell(order, utxo, pool, { payout }), order, 'payout must go to the recipient', {
      poolPasses: true,
    });
  });

  it('rejects one order token burned instead of going into the pool', () => {
    const { pool, order, utxo } = setup();
    const partial = sellFill(POOL, TOKENS_IN - 1n);
    const built = rawSell(order, utxo, pool, {
      tokensIntoPool: TOKENS_IN - 1n,
      bchOut: partial.bchOut,
      payoutSats: partial.bchOut + 1000n,
    });
    expectCovenantRejects(built, order, 'every order token must go into the pool', { poolPasses: true });
  });

  it('rejects the pool output redirected to the attacker', () => {
    const { pool, order, utxo } = setup();
    const poolOut = tokenOutput(
      STRANGER.lockingBytecode,
      BEST.poolAfter.sats,
      CATEGORY,
      BEST.poolAfter.tokens,
    );
    expectCovenantRejects(rawSell(order, utxo, pool, { poolOut }), order, 'pool must continue at output 0');
  });

  it('rejects a third output', () => {
    const { pool, order, utxo } = setup();
    const base = rawSell(order, utxo, pool, { payoutSats: DEFAULT_PAYOUT - 546n });
    const built = rawTransaction(
      [poolInput(pool), executeInput(order, utxo, pool.ownerPkh)],
      [...base.transaction.outputs, { lockingBytecode: STRANGER.lockingBytecode, valueSatoshis: 546n }],
    );
    expectCovenantRejects(built, order, 'exactly two outputs');
  });
});

describe('adversarial AtPriceSell.execute: fee bypass', () => {
  it('rejects a miner fee one satoshi above maxNetworkFee', () => {
    const { pool, order, utxo } = setup();
    expectCovenantRejects(
      rawSell(order, utxo, pool, { payoutSats: BEST.bchOut + 2000n - MAX_FEE - 1n }),
      order,
      'network fee above maxNetworkFee',
      { poolPasses: true },
    );
  });

  it('rejects a payout that keeps only the 2000 order sats while the pool pays the miner', () => {
    const { pool, order, utxo } = setup();
    expectCovenantRejects(
      rawSell(order, utxo, pool, { payoutSats: 2001n }),
      order,
      'network fee above maxNetworkFee',
      {
        poolPasses: true,
      },
    );
  });
});

describe('adversarial AtPriceSell.execute: best fill and minOut boundaries', () => {
  it('rejects a fill that leaves one satoshi in the pool, which the pool alone would accept', () => {
    const { pool, order, utxo } = setup();
    const bchOut = BEST.bchOut - 1n;
    expectCovenantRejects(
      rawSell(order, utxo, pool, { bchOut, payoutSats: bchOut + 1000n }),
      order,
      'fill leaves BCH in the pool',
      { poolPasses: true },
    );
  });

  it('one satoshi more than the best fill is refused by the pool, and the covenant does not need to', () => {
    const { pool, order, utxo } = setup();
    const bchOut = BEST.bchOut + 1n;
    const built = rawSell(order, utxo, pool, { bchOut, payoutSats: bchOut + 1000n });
    expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 0).ok).toBe(false);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 1, order.contract.artifact)).toEqual({
      ok: true,
    });
  });

  it('rejects a payout one satoshi below minOut', () => {
    const { pool, order, utxo } = setup({ minOut: DEFAULT_PAYOUT + 1n });
    expectCovenantRejects(rawSell(order, utxo, pool), order, 'payout below minOut', { poolPasses: true });
  });
});

describe('adversarial AtPriceSell.execute: pool authenticity and token impersonation', () => {
  it('rejects the pool spent through its withdraw branch with a valid pool-owner signature', () => {
    const { pool, order, utxo } = setup();
    const base = rawSell(order, utxo, pool);
    const built = rawTransaction(
      [poolInput(pool, poolWithdrawUnlock(POOL_OWNER)), executeInput(order, utxo, pool.ownerPkh)],
      base.transaction.outputs,
    );
    expectCovenantRejects(built, order, 'pool must be spent through its exchange branch', {
      poolPasses: true,
    });
  });

  it('rejects a genuine pool of another token (order tokens would be burned)', () => {
    const { chain, order, utxo } = setup();
    const other = chain.addPool(POOL, { category: OTHER_CATEGORY, owner: OTHER_POOL_OWNER });
    const built = rawTransaction(
      [poolInput(other), executeInput(order, utxo, other.ownerPkh)],
      [
        poolOutput(other, { sats: POOL.sats, tokens: POOL.tokens }),
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n },
      ],
    );
    expectCovenantRejects(built, order, 'pool input holds another token', { poolPasses: true });
  });

  it('rejects a sell order UTXO of another category', () => {
    const { chain, pool, order } = setup();
    const stray = chain.addUtxoAt(order, {
      satoshis: 2000n,
      token: { category: OTHER_CATEGORY, amount: TOKENS_IN },
    });
    const built = rawTransaction(
      [poolInput(pool), executeInput(order, stray, pool.ownerPkh)],
      [poolOutput(pool, POOL), { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n }],
    );
    expectCovenantRejects(built, order, 'sell order holds another token', { poolPasses: true });
  });

  it('rejects a sell order UTXO of the right category carrying a minting NFT', () => {
    const { chain, pool, order } = setup();
    const stray = chain.addUtxoAt(order, {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN, nft: { capability: 'minting', commitment: '' } },
    });
    expectCovenantRejects(rawSell(order, stray, pool), order, 'sell order holds another token', {
      poolPasses: true,
    });
  });

  it('rejects moving an immutable NFT from the sell order into the payout', () => {
    const { chain, pool, order } = setup();
    const stray = chain.addUtxoAt(order, {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN, nft: { capability: 'none', commitment: 'beef' } },
    });
    const payout = {
      lockingBytecode: OWNER.lockingBytecode,
      valueSatoshis: DEFAULT_PAYOUT,
      token: {
        category: hexToBin(CATEGORY),
        amount: 0n,
        nft: { capability: 'none' as const, commitment: hexToBin('beef') },
      },
    };
    expectCovenantRejects(rawSell(order, stray, pool, { payout }), order, 'payout must not hold tokens', {
      poolPasses: true,
    });
  });

  it('documents (advisory): a filler may execute a sell UTXO that also carries an immutable NFT and burn the NFT', async () => {
    // #given a sell order UTXO that (by user mistake) also holds an immutable NFT of the market category
    const { chain, pool, order } = setup();
    const stray = chain.addUtxoAt(order, {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN, nft: { capability: 'none', commitment: 'beef' } },
    });
    // #when a permissionless filler executes it without carrying the NFT anywhere
    // #then the covenant accepts: minOut is met, but the NFT is destroyed (cancel would have mirrored it)
    await expectAcceptedRaw(chain, rawSell(order, stray, pool));
  });
});

describe('adversarial AtPriceSell.execute: index games and version', () => {
  it('rejects the order at input 0', () => {
    const { pool, order, utxo } = setup();
    const built = rawTransaction(
      [executeInput(order, utxo, pool.ownerPkh), poolInput(pool)],
      [
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: DEFAULT_PAYOUT },
        poolOutput(pool, BEST.poolAfter),
      ],
    );
    expectCovenantRejects(built, order, 'order must be input 1', { input: 0 });
  });

  it('rejects a third input', () => {
    const { chain, pool, order, utxo } = setup();
    const extra = chain.addP2pkh(STRANGER, 10_000n);
    const base = rawSell(order, utxo, pool);
    const built = rawTransaction(
      [
        poolInput(pool),
        executeInput(order, utxo, pool.ownerPkh),
        { utxo: extra, unlock: contractUnlock(STRANGER.signer.unlockP2PKH()) },
      ],
      base.transaction.outputs,
    );
    expectCovenantRejects(built, order, 'exactly two inputs');
  });

  it('tx.version 1: refused by the pool, which the covenant relies on', () => {
    const { pool, order, utxo } = setup();
    const built = rawSell(order, utxo, pool, { version: 1 });
    expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 0).ok).toBe(false);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 1, order.contract.artifact)).toEqual({
      ok: true,
    });
  });

  it('rejects a sell execute inside a cancel shape (owner input at 0)', () => {
    const { chain, order, utxo } = setup();
    const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
    const built = rawTransaction(
      [
        { utxo: ownerUtxo, unlock: contractUnlock(OWNER.signer.unlockP2PKH()) },
        executeInput(order, utxo, POOL_OWNER.pkh),
      ],
      [
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n },
        tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, TOKENS_IN),
      ],
    );
    expectCovenantRejects(built, order, 'input 0 is not a Cauldron V0 pool');
  });
});

describe('adversarial AtPriceSell.execute: magnitude (B0*T0 > 2^100)', () => {
  const BIG: PoolReserves = { sats: 2n ** 50n, tokens: 2n ** 62n };
  const BIG_TOKENS = 2n ** 60n;
  const bigBest = sellFill(BIG, BIG_TOKENS);

  const bigSetup = (minOut: bigint) => {
    expect(BIG.sats * BIG.tokens > 2n ** 100n).toBe(true);
    const chain = new Chain();
    const pool = chain.addPool(BIG);
    const { order, utxo } = chain.addOrder(orderParams('sell', { minOut }), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: BIG_TOKENS },
    });
    return { chain, pool, order, utxo };
  };

  it('accepts the exact best fill with payout exactly minOut', async () => {
    const { chain, pool, order, utxo } = bigSetup(bigBest.bchOut + 1000n);
    await expectAcceptedRaw(chain, rawSell(order, utxo, pool));
  });

  it('rejects leaving one satoshi in the pool at magnitude', () => {
    const { pool, order, utxo } = bigSetup(2001n);
    const bchOut = bigBest.bchOut - 1n;
    expectCovenantRejects(
      rawSell(order, utxo, pool, { bchOut, payoutSats: bchOut + 1000n }),
      order,
      'fill leaves BCH in the pool',
      {
        poolPasses: true,
      },
    );
  });

  it('rejects a payout one below minOut at magnitude', () => {
    const { pool, order, utxo } = bigSetup(bigBest.bchOut + 1001n);
    expectCovenantRejects(rawSell(order, utxo, pool), order, 'payout below minOut', { poolPasses: true });
  });
});
