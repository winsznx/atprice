import { binToHex, encodeLockingBytecodeP2sh32, flattenBinArray, hash256, hexToBin } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { poolLockingBytecode, poolRedeemScript, sellFill, type PoolReserves } from '@atprice/core';
import {
  CATEGORY,
  Chain,
  contractUnlock,
  orderParams,
  OTHER_POOL_OWNER,
  OWNER,
  POOL_OWNER,
  poolOutput,
  rawTransaction,
  STRANGER,
  tokenOutput,
} from '../harness.js';
import {
  addNftPool,
  evaluateInput,
  executeInput,
  expectAcceptedRaw,
  expectCovenantRejects,
  poolInput,
  rawSell,
  verifyAll,
} from './support.js';

const POOL: PoolReserves = { sats: 150_545_039n, tokens: 29_857n };
const TOKENS_IN = 1000n;
const MAX_FEE = 2000n;
const BEST = sellFill(POOL, TOKENS_IN);
const DEFAULT_PAYOUT = BEST.bchOut + 2000n - 1000n;

const setup = (funding: { satoshis?: bigint } = {}) => {
  const chain = new Chain();
  const pool = chain.addPool(POOL);
  const { order, utxo } = chain.addOrder(orderParams('sell'), {
    satoshis: funding.satoshis ?? 2000n,
    token: { category: CATEGORY, amount: TOKENS_IN },
  });
  return { chain, pool, order, utxo };
};

describe('adversarial AtPriceSell.execute: pool authenticity (sell side)', () => {
  it('positive control: the same harness accepts the unmodified sell fill', async () => {
    const { chain, pool, order, utxo } = setup();
    await expectAcceptedRaw(chain, rawSell(order, utxo, pool));
  });

  it('rejects a fake pool (P2SH32 of OP_1) that would pay out anything', () => {
    const { chain, order, utxo } = setup();
    const fakeLocking = encodeLockingBytecodeP2sh32(hash256(Uint8Array.of(0x51)));
    const fake = chain.provider.addUtxo(binToHex(fakeLocking), {
      txid: 'ef'.repeat(32),
      vout: 0,
      satoshis: POOL.sats,
      token: { category: CATEGORY, amount: POOL.tokens },
    });
    // The attacker drains the fake pool's BCH into a payout to the owner while leaving it 1000 sats.
    const built = rawTransaction(
      [
        { utxo: { ...fake, lockingBytecode: binToHex(fakeLocking) }, unlock: Uint8Array.of(0x01, 0x51) },
        executeInput(order, utxo, POOL_OWNER.pkh),
      ],
      [
        tokenOutput(fakeLocking, 1000n, CATEGORY, POOL.tokens + TOKENS_IN),
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n },
      ],
    );
    expectCovenantRejects(built, order, 'input 0 is not a Cauldron V0 pool', { poolPasses: true });
  });

  it('rejects a genuine pool when execute names another pool owner hash', () => {
    const { pool, order, utxo } = setup();
    const base = rawSell(order, utxo, pool);
    const built = rawTransaction(
      [poolInput(pool), executeInput(order, utxo, OTHER_POOL_OWNER.pkh)],
      base.transaction.outputs,
    );
    expectCovenantRejects(built, order, 'input 0 is not a Cauldron V0 pool', { poolPasses: true });
  });

  it('rejects the exchange branch reached through a non-canonical push (OP_PUSHDATA1)', () => {
    const { pool, order, utxo } = setup();
    const base = rawSell(order, utxo, pool);
    const unlock = flattenBinArray([Uint8Array.of(0x4c, 0x44), poolRedeemScript(pool.ownerPkh)]);
    const built = rawTransaction(
      [poolInput(pool, unlock), executeInput(order, utxo, pool.ownerPkh)],
      base.transaction.outputs,
    );
    expectCovenantRejects(built, order, 'pool must be spent through its exchange branch');
  });

  it.each(['minting', 'mutable'] as const)(
    'rejects a pool of the right category whose token carries a %s NFT',
    (capability) => {
      const { chain, order, utxo } = setup();
      const pool = addNftPool(chain, OTHER_POOL_OWNER, POOL, CATEGORY, { capability, commitment: 'c0ffee' });
      const poolOut = {
        ...poolOutput(pool, BEST.poolAfter),
        token: {
          category: hexToBin(CATEGORY),
          amount: BEST.poolAfter.tokens,
          nft: { capability, commitment: hexToBin('c0ffee') },
        },
      };
      expectCovenantRejects(
        rawSell(order, utxo, pool, { poolOut }),
        order,
        'pool input holds another token',
        {
          poolPasses: true,
        },
      );
    },
  );

  it("rejects the pool output moved into the attacker's own genuine Cauldron pool", () => {
    const { pool, order, utxo } = setup();
    const poolOut = {
      ...poolOutput(pool, BEST.poolAfter),
      lockingBytecode: poolLockingBytecode(OTHER_POOL_OWNER.pkh),
    };
    expectCovenantRejects(rawSell(order, utxo, pool, { poolOut }), order, 'pool must continue at output 0');
  });

  it('rejects swapped outputs (payout at 0, pool at 1)', () => {
    const { pool, order, utxo } = setup();
    const built = rawTransaction(
      [poolInput(pool), executeInput(order, utxo, pool.ownerPkh)],
      [
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: DEFAULT_PAYOUT },
        poolOutput(pool, BEST.poolAfter),
      ],
    );
    expectCovenantRejects(built, order, 'pool must continue at output 0');
  });
});

describe('adversarial AtPriceSell.execute: order-input impersonation and stray value', () => {
  it('rejects a sell order UTXO of the right category carrying a mutable NFT', () => {
    const { chain, pool, order } = setup();
    const stray = chain.addUtxoAt(order, {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN, nft: { capability: 'mutable', commitment: '01' } },
    });
    expectCovenantRejects(rawSell(order, stray, pool), order, 'sell order holds another token', {
      poolPasses: true,
    });
  });

  it('rejects a filler keeping the extra BCH of a sell UTXO that holds 1,000,000 sats as miner fee', () => {
    const { pool, order, utxo } = setup({ satoshis: 1_000_000n });
    const payoutSats = BEST.bchOut + 2000n - 1000n;
    expectCovenantRejects(
      rawSell(order, utxo, pool, { payoutSats }),
      order,
      'network fee above maxNetworkFee',
      { poolPasses: true },
    );
  });

  it('accepts the same 1,000,000-sat sell UTXO when the payout returns all but maxNetworkFee (control)', async () => {
    const { chain, pool, order, utxo } = setup({ satoshis: 1_000_000n });
    await expectAcceptedRaw(
      chain,
      rawSell(order, utxo, pool, { payoutSats: BEST.bchOut + 1_000_000n - MAX_FEE }),
    );
  });

  it('rejects one order token routed into the payout instead of the pool', () => {
    const { pool, order, utxo } = setup();
    const partial = sellFill(POOL, TOKENS_IN - 1n);
    const built = rawSell(order, utxo, pool, {
      tokensIntoPool: TOKENS_IN - 1n,
      bchOut: partial.bchOut,
      payout: tokenOutput(OWNER.lockingBytecode, partial.bchOut + 1000n, CATEGORY, 1n),
    });
    expectCovenantRejects(built, order, 'every order token must go into the pool', { poolPasses: true });
  });
});

describe('adversarial AtPriceSell.execute: shape games', () => {
  it('rejects a single-output transaction (payout dropped, BCH to the miner)', () => {
    const { pool, order, utxo } = setup();
    const built = rawTransaction(
      [poolInput(pool), executeInput(order, utxo, pool.ownerPkh)],
      [poolOutput(pool, BEST.poolAfter)],
    );
    expectCovenantRejects(built, order, 'exactly two outputs');
  });

  it('rejects two sell orders filled against one pool in one transaction', () => {
    const { chain, pool, order, utxo } = setup();
    const second = chain.addOrder(orderParams('sell', { nonce: Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9) }), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN },
    });
    const both = sellFill(POOL, 2n * TOKENS_IN);
    const built = rawTransaction(
      [
        poolInput(pool),
        executeInput(order, utxo, pool.ownerPkh),
        executeInput(second.order, second.utxo, pool.ownerPkh),
      ],
      [
        poolOutput(pool, both.poolAfter),
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: both.bchOut + 3000n },
      ],
    );
    expectCovenantRejects(built, order, 'exactly two inputs');
    expectCovenantRejects(built, second.order, 'order must be input 1', { input: 2 });
  });

  it('tx.version 3: refused by the pool, which the covenant relies on', () => {
    const { pool, order, utxo } = setup();
    const built = rawSell(order, utxo, pool, { version: 3 });
    expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 0).ok).toBe(false);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 1, order.contract.artifact)).toEqual({
      ok: true,
    });
  });
});

describe('adversarial AtPriceSell: cancel-vs-execute shapes', () => {
  it('rejects an execute-shaped transaction that unlocks the sell order with cancel()', () => {
    const { pool, order, utxo } = setup();
    const base = rawSell(order, utxo, pool);
    const built = rawTransaction(
      [poolInput(pool), { utxo, unlock: contractUnlock(order.contract.unlock.cancel()) }],
      base.transaction.outputs,
    );
    expectCovenantRejects(built, order, 'input 0 must be the owner', { poolPasses: true });
  });

  it('rejects an execute-shaped transaction that unlocks the sell order with a stranger cancelWithSig', () => {
    const { pool, order, utxo } = setup();
    const base = rawSell(order, utxo, pool);
    const built = rawTransaction(
      [
        poolInput(pool),
        {
          utxo,
          unlock: contractUnlock(order.contract.unlock.cancelWithSig(STRANGER.publicKey, STRANGER.signer)),
        },
      ],
      base.transaction.outputs,
    );
    expectCovenantRejects(built, order, 'not the owner key', { poolPasses: true });
  });
});

describe('adversarial AtPriceSell.execute: fee at magnitude (B0*T0 > 2^100)', () => {
  const BIG: PoolReserves = { sats: 2n ** 50n, tokens: 2n ** 62n };
  const BIG_TOKENS = 2n ** 60n;
  const bigBest = sellFill(BIG, BIG_TOKENS);

  const bigSetup = () => {
    expect(BIG.sats * BIG.tokens > 2n ** 100n).toBe(true);
    const chain = new Chain();
    const pool = chain.addPool(BIG);
    const { order, utxo } = chain.addOrder(orderParams('sell'), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: BIG_TOKENS },
    });
    return { chain, pool, order, utxo };
  };

  it('accepts a miner fee of exactly maxNetworkFee at magnitude', async () => {
    const { chain, pool, order, utxo } = bigSetup();
    await expectAcceptedRaw(
      chain,
      rawSell(order, utxo, pool, { payoutSats: bigBest.bchOut + 2000n - MAX_FEE }),
    );
  });

  it('rejects a miner fee one satoshi above maxNetworkFee at magnitude', () => {
    const { pool, order, utxo } = bigSetup();
    expectCovenantRejects(
      rawSell(order, utxo, pool, { payoutSats: bigBest.bchOut + 2000n - MAX_FEE - 1n }),
      order,
      'network fee above maxNetworkFee',
      { poolPasses: true },
    );
  });
});
