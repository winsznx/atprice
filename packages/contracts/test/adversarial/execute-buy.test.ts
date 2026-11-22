import { binToHex, encodeLockingBytecodeP2sh32, flattenBinArray, hash256, hexToBin } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { buyFill, poolLockingBytecode, poolRedeemScript, type PoolReserves } from '@atprice/core';
import {
  CATEGORY,
  Chain,
  contractUnlock,
  OTHER_CATEGORY,
  OTHER_POOL_OWNER,
  orderParams,
  OWNER,
  P2SH32_RECIPIENT,
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
  poolWithdrawUnlock,
  rawBuy,
  verifyAll,
} from './support.js';

const POOL: PoolReserves = { sats: 150_545_039n, tokens: 29_857n };
const MAX_FEE = 2000n;
const SPEND = 10_000_000n;
const VALUE = SPEND + 1000n + MAX_FEE;
/** rawBuy's default: a 1000-sat miner fee, so the rest of the allowance goes into the pool. */
const DEFAULT_BCH_IN = VALUE - 1000n - 1000n;
const BEST = buyFill(POOL, DEFAULT_BCH_IN);

const setup = (overrides: Parameters<typeof orderParams>[1] = {}) => {
  const chain = new Chain();
  const pool = chain.addPool(POOL);
  const { order, utxo } = chain.addOrder(orderParams('buy', overrides), { satoshis: VALUE });
  return { chain, pool, order, utxo };
};

describe('adversarial AtPriceBuy.execute: positive controls', () => {
  it('accepts the unmodified hand-built best fill (harness can accept)', async () => {
    const { chain, pool, order, utxo } = setup();
    const built = rawBuy(order, utxo, pool);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 1, order.contract.artifact)).toEqual({
      ok: true,
    });
    await expectAcceptedRaw(chain, built);
  });

  it('accepts a miner fee of exactly maxNetworkFee', async () => {
    const { chain, pool, order, utxo } = setup();
    await expectAcceptedRaw(chain, rawBuy(order, utxo, pool, { bchIn: VALUE - 1000n - MAX_FEE }));
  });

  it('accepts received exactly equal to minOut', async () => {
    const { chain, pool, order, utxo } = setup({ minOut: BEST.tokensOut });
    await expectAcceptedRaw(chain, rawBuy(order, utxo, pool));
  });
});

describe('adversarial AtPriceBuy.execute: altered outputs and redirected tokens', () => {
  it('rejects the payout sent to a stranger', () => {
    const { pool, order, utxo } = setup();
    const payout = tokenOutput(STRANGER.lockingBytecode, 1000n, CATEGORY, BEST.tokensOut);
    expectCovenantRejects(rawBuy(order, utxo, pool, { payout }), order, 'payout must go to the recipient', {
      poolPasses: true,
    });
  });

  it('rejects the payout sent to a P2SH32 of the right length but wrong hash', () => {
    const { pool, order, utxo } = setup({ recipientLockingBytecode: P2SH32_RECIPIENT });
    const lookalike = encodeLockingBytecodeP2sh32(new Uint8Array(32).fill(0x5b));
    const payout = tokenOutput(lookalike, 1000n, CATEGORY, BEST.tokensOut);
    expectCovenantRejects(rawBuy(order, utxo, pool, { payout }), order, 'payout must go to the recipient', {
      poolPasses: true,
    });
  });

  it('rejects a token-less payout (released tokens burned)', () => {
    const { pool, order, utxo } = setup();
    const payout = { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n };
    expectCovenantRejects(rawBuy(order, utxo, pool, { payout }), order, 'payout holds another token', {
      poolPasses: true,
    });
  });

  it('rejects a payout one token short of what the pool released (one token burned)', () => {
    const { pool, order, utxo } = setup();
    const payout = tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, BEST.tokensOut - 1n);
    expectCovenantRejects(
      rawBuy(order, utxo, pool, { payout }),
      order,
      'payout must carry every token the pool released',
      { poolPasses: true },
    );
  });

  it('rejects a payout of 999 and of 1001 sats', () => {
    const { pool, order, utxo } = setup();
    for (const sats of [999n, 1001n]) {
      const payout = tokenOutput(OWNER.lockingBytecode, sats, CATEGORY, BEST.tokensOut);
      expectCovenantRejects(
        rawBuy(order, utxo, pool, { payout }),
        order,
        'payout must carry exactly 1000 sats',
        {
          poolPasses: true,
        },
      );
    }
  });

  it('rejects the pool output redirected to the attacker', () => {
    const { pool, order, utxo } = setup();
    const poolOut = tokenOutput(
      STRANGER.lockingBytecode,
      POOL.sats + DEFAULT_BCH_IN,
      CATEGORY,
      BEST.poolAfter.tokens,
    );
    const built = rawBuy(order, utxo, pool, { poolOut });
    expectCovenantRejects(built, order, 'pool must continue at output 0');
    expect(evaluateInput(built.transaction, built.sourceOutputs, 0).ok).toBe(false);
  });

  it("rejects the pool output moved into the attacker's own genuine Cauldron pool", () => {
    const { pool, order, utxo } = setup();
    const poolOut = {
      ...poolOutput(pool, BEST.poolAfter),
      lockingBytecode: poolLockingBytecode(OTHER_POOL_OWNER.pkh),
    };
    expectCovenantRejects(rawBuy(order, utxo, pool, { poolOut }), order, 'pool must continue at output 0');
  });

  it('rejects swapped outputs (payout at 0, pool at 1)', () => {
    const { pool, order, utxo } = setup();
    const built = rawBuy(order, utxo, pool, {
      poolOut: tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, BEST.tokensOut),
      payout: poolOutput(pool, BEST.poolAfter),
    });
    expectCovenantRejects(built, order, 'pool must continue at output 0');
  });

  it('rejects a third output, whether a payment to the attacker or an OP_RETURN', () => {
    const { pool, order, utxo } = setup();
    const extras = [
      { lockingBytecode: STRANGER.lockingBytecode, valueSatoshis: 546n },
      { lockingBytecode: Uint8Array.of(0x6a, 0x01, 0x01), valueSatoshis: 0n },
    ];
    for (const extra of extras) {
      const bchIn = DEFAULT_BCH_IN - extra.valueSatoshis;
      expectCovenantRejects(
        rawBuy(order, utxo, pool, { bchIn, extraOutputs: [extra] }),
        order,
        'exactly two outputs',
      );
    }
  });

  it('rejects a single-output transaction (payout dropped)', () => {
    const { pool, order, utxo } = setup();
    const built = rawTransaction(
      [poolInput(pool), executeInput(order, utxo, pool.ownerPkh)],
      [poolOutput(pool, BEST.poolAfter)],
    );
    expectCovenantRejects(built, order, 'exactly two outputs');
  });
});

describe('adversarial AtPriceBuy.execute: fee bypass and partial fills', () => {
  it('rejects a miner fee one satoshi above maxNetworkFee', () => {
    const { pool, order, utxo } = setup();
    expectCovenantRejects(
      rawBuy(order, utxo, pool, { bchIn: VALUE - 1000n - MAX_FEE - 1n }),
      order,
      'network fee above maxNetworkFee',
      { poolPasses: true },
    );
  });

  it('rejects only half of the order going into the pool (rest to the miner)', () => {
    const { pool, order, utxo } = setup();
    expectCovenantRejects(
      rawBuy(order, utxo, pool, { bchIn: SPEND / 2n }),
      order,
      'network fee above maxNetworkFee',
      {
        poolPasses: true,
      },
    );
  });

  it('rejects a pool that pays out BCH instead of taking it (bchIn negative)', () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const { order, utxo } = chain.addOrder(orderParams('buy'), { satoshis: VALUE });
    const built = rawBuy(order, utxo, pool, {
      bchIn: -1000n,
      tokensOut: 1n,
      payout: tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, 1n),
    });
    expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
    const verdict = evaluateInput(built.transaction, built.sourceOutputs, 1, order.contract.artifact);
    expect(verdict.ok).toBe(false);
  });
});

describe('adversarial AtPriceBuy.execute: best fill and minOut boundaries', () => {
  it('rejects a fill that leaves one token in the pool, which the pool alone would accept', () => {
    const { pool, order, utxo } = setup();
    expectCovenantRejects(
      rawBuy(order, utxo, pool, { tokensOut: BEST.tokensOut - 1n }),
      order,
      'fill leaves tokens in the pool',
      { poolPasses: true },
    );
  });

  it('one token more than the best fill is refused by the pool, and the covenant does not need to', () => {
    const { pool, order, utxo } = setup();
    const built = rawBuy(order, utxo, pool, { tokensOut: BEST.tokensOut + 1n });
    expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 0).ok).toBe(false);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 1, order.contract.artifact)).toEqual({
      ok: true,
    });
  });

  it('rejects received one below minOut', () => {
    const { pool, order, utxo } = setup({ minOut: BEST.tokensOut + 1n });
    expectCovenantRejects(rawBuy(order, utxo, pool), order, 'received below minOut', { poolPasses: true });
  });
});

describe('adversarial AtPriceBuy.execute: pool authenticity and token impersonation', () => {
  it('rejects a fake pool (P2SH32 of OP_1) that would accept anything', () => {
    const { chain, order, utxo } = setup();
    const fakeLocking = encodeLockingBytecodeP2sh32(hash256(Uint8Array.of(0x51)));
    const fake = chain.provider.addUtxo(binToHex(fakeLocking), {
      txid: 'ee'.repeat(32),
      vout: 0,
      satoshis: POOL.sats,
      token: { category: CATEGORY, amount: POOL.tokens },
    });
    const built = rawTransaction(
      [
        { utxo: { ...fake, lockingBytecode: binToHex(fakeLocking) }, unlock: Uint8Array.of(0x01, 0x51) },
        executeInput(order, utxo, POOL_OWNER.pkh),
      ],
      [
        tokenOutput(fakeLocking, POOL.sats + DEFAULT_BCH_IN, CATEGORY, 1n),
        tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, POOL.tokens - 1n),
      ],
    );
    expectCovenantRejects(built, order, 'input 0 is not a Cauldron V0 pool', { poolPasses: true });
  });

  it('rejects a genuine pool when execute names another pool owner hash', () => {
    const { pool, order, utxo } = setup();
    expectCovenantRejects(
      rawBuy(order, utxo, pool, { poolPkh: OTHER_POOL_OWNER.pkh }),
      order,
      'input 0 is not a Cauldron V0 pool',
      { poolPasses: true },
    );
  });

  it('rejects a genuine pool of another token', () => {
    const { chain, order, utxo } = setup();
    const other = chain.addPool(POOL, { category: OTHER_CATEGORY, owner: OTHER_POOL_OWNER });
    const built = rawBuy(order, utxo, other, {
      payout: tokenOutput(OWNER.lockingBytecode, 1000n, OTHER_CATEGORY, BEST.tokensOut),
    });
    expectCovenantRejects(built, order, 'pool input holds another token', { poolPasses: true });
  });

  it.each(['minting', 'mutable'] as const)(
    'rejects a pool of the right category whose token carries a %s NFT',
    (capability) => {
      const { chain, order, utxo } = setup();
      const nft = { capability, commitment: 'c0ffee' };
      const pool = addNftPool(chain, OTHER_POOL_OWNER, POOL, CATEGORY, nft);
      const poolOut = {
        ...poolOutput(pool, BEST.poolAfter),
        token: {
          category: hexToBin(CATEGORY),
          amount: BEST.poolAfter.tokens,
          nft: { capability, commitment: hexToBin('c0ffee') },
        },
      };
      const built = rawBuy(order, utxo, pool, { poolOut });
      expectCovenantRejects(built, order, 'pool input holds another token', { poolPasses: true });
    },
  );

  it('documents: an immutable-NFT pool of the right category passes, and the order still gets its full fill', async () => {
    const { chain, order, utxo } = setup();
    const pool = addNftPool(chain, OTHER_POOL_OWNER, POOL, CATEGORY, {
      capability: 'none',
      commitment: 'aa',
    });
    const poolOut = {
      ...poolOutput(pool, BEST.poolAfter),
      token: {
        category: hexToBin(CATEGORY),
        amount: BEST.poolAfter.tokens,
        nft: { capability: 'none' as const, commitment: hexToBin('aa') },
      },
    };
    await expectAcceptedRaw(chain, rawBuy(order, utxo, pool, { poolOut }));
  });

  it('rejects the pool spent through its withdraw branch with a valid pool-owner signature', () => {
    const { pool, order, utxo } = setup();
    const built = rawBuy(order, utxo, pool, { poolUnlock: poolWithdrawUnlock(POOL_OWNER) });
    expectCovenantRejects(built, order, 'pool must be spent through its exchange branch', {
      poolPasses: true,
    });
  });

  it('rejects the exchange branch reached through a non-canonical push (OP_PUSHDATA1)', () => {
    const { pool, order, utxo } = setup();
    const unlock = flattenBinArray([Uint8Array.of(0x4c, 0x44), poolRedeemScript(pool.ownerPkh)]);
    const built = rawBuy(order, utxo, pool, { poolUnlock: unlock });
    expectCovenantRejects(built, order, 'pool must be spent through its exchange branch');
  });
});

describe('adversarial AtPriceBuy.execute: index games and version', () => {
  it('rejects the order at input 0', () => {
    const { pool, order, utxo } = setup();
    const built = rawTransaction(
      [executeInput(order, utxo, pool.ownerPkh), poolInput(pool)],
      [tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, BEST.tokensOut), poolOutput(pool, BEST.poolAfter)],
    );
    expectCovenantRejects(built, order, 'order must be input 1', { input: 0 });
  });

  it('rejects a third input (attacker P2PKH)', () => {
    const { chain, pool, order, utxo } = setup();
    const extra = chain.addP2pkh(STRANGER, 10_000n);
    const built = rawBuy(order, utxo, pool, {
      extraInputs: [{ utxo: extra, unlock: contractUnlock(STRANGER.signer.unlockP2PKH()) }],
    });
    expectCovenantRejects(built, order, 'exactly two inputs');
  });

  it('rejects two orders filled against one pool in one transaction', () => {
    const { chain, pool, order, utxo } = setup();
    const second = chain.addOrder(orderParams('buy', { nonce: Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9) }), {
      satoshis: VALUE,
    });
    const built = rawBuy(order, utxo, pool, {
      extraInputs: [executeInput(second.order, second.utxo, pool.ownerPkh)],
    });
    expectCovenantRejects(built, order, 'exactly two inputs');
    expectCovenantRejects(built, second.order, 'order must be input 1', { input: 2 });
  });

  it.each([1, 3])(
    'tx.version %i: refused by the pool (the covenant delegates the version rule to it)',
    (version) => {
      const { pool, order, utxo } = setup();
      const built = rawBuy(order, utxo, pool, { version });
      expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
      expect(evaluateInput(built.transaction, built.sourceOutputs, 0).ok).toBe(false);
      expect(evaluateInput(built.transaction, built.sourceOutputs, 1, order.contract.artifact)).toEqual({
        ok: true,
      });
    },
  );
});

describe('adversarial AtPriceBuy.execute: order-input impersonation', () => {
  it('rejects a buy order UTXO that holds tokens (stray deposit of the market token)', () => {
    const { chain, pool, order } = setup();
    const stray = chain.addUtxoAt(order, { satoshis: VALUE, token: { category: CATEGORY, amount: 5n } });
    expectCovenantRejects(rawBuy(order, stray, pool), order, 'buy order must not hold tokens');
  });

  it('rejects a buy order UTXO that holds an immutable NFT of the market category', () => {
    const { chain, pool, order } = setup();
    const stray = chain.addUtxoAt(order, {
      satoshis: VALUE,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: '' } },
    });
    expectCovenantRejects(rawBuy(order, stray, pool), order, 'buy order must not hold tokens');
  });
});

describe('adversarial AtPriceBuy: cancel-vs-execute shapes', () => {
  it('rejects an execute-shaped transaction that unlocks the order with cancel()', () => {
    const { pool, order, utxo } = setup();
    const built = rawTransaction(
      [poolInput(pool), { utxo, unlock: contractUnlock(order.contract.unlock.cancel()) }],
      [poolOutput(pool, BEST.poolAfter), tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, BEST.tokensOut)],
    );
    expectCovenantRejects(built, order, 'input 0 must be the owner', { poolPasses: true });
  });

  it('rejects an execute-shaped transaction that unlocks the order with a stranger cancelWithSig', () => {
    const { pool, order, utxo } = setup();
    const built = rawTransaction(
      [
        poolInput(pool),
        {
          utxo,
          unlock: contractUnlock(order.contract.unlock.cancelWithSig(STRANGER.publicKey, STRANGER.signer)),
        },
      ],
      [poolOutput(pool, BEST.poolAfter), tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, BEST.tokensOut)],
    );
    expectCovenantRejects(built, order, 'not the owner key', { poolPasses: true });
  });

  it('rejects owner pubkey with a stranger signature in an execute shape', () => {
    const { pool, order, utxo } = setup({ recipientLockingBytecode: P2SH32_RECIPIENT });
    const built = rawTransaction(
      [
        poolInput(pool),
        {
          utxo,
          unlock: contractUnlock(order.contract.unlock.cancelWithSig(OWNER.publicKey, STRANGER.signer)),
        },
      ],
      [poolOutput(pool, BEST.poolAfter), tokenOutput(P2SH32_RECIPIENT, 1000n, CATEGORY, BEST.tokensOut)],
    );
    expectCovenantRejects(built, order, 'refund must go to the owner', { poolPasses: true });
  });

  it('rejects execute() inside a cancel-shaped transaction (owner input at 0, refund at 1)', () => {
    const { chain, order, utxo } = setup();
    const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
    const built = rawTransaction(
      [
        { utxo: ownerUtxo, unlock: contractUnlock(OWNER.signer.unlockP2PKH()) },
        executeInput(order, utxo, POOL_OWNER.pkh),
      ],
      [
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n },
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: VALUE - 1000n },
      ],
    );
    expectCovenantRejects(built, order, 'input 0 is not a Cauldron V0 pool');
  });
});

describe('adversarial AtPriceBuy.execute: magnitude (B0*T0 > 2^100)', () => {
  const BIG: PoolReserves = { sats: 2n ** 50n, tokens: 2n ** 63n - 1n };
  const BIG_VALUE = 2n ** 44n;
  const bigBest = buyFill(BIG, BIG_VALUE - 2000n);

  const bigSetup = (minOut: bigint) => {
    expect(BIG.sats * BIG.tokens > 2n ** 100n).toBe(true);
    const chain = new Chain();
    const pool = chain.addPool(BIG);
    const { order, utxo } = chain.addOrder(orderParams('buy', { minOut }), { satoshis: BIG_VALUE });
    return { chain, pool, order, utxo };
  };

  it('accepts the exact best fill at minOut with 2^50 sats and 2^63-1 tokens in the pool', async () => {
    // #given an order whose minOut is exactly the best fill
    const { chain, pool, order, utxo } = bigSetup(bigBest.tokensOut);
    // #when / #then the hand-built best fill is accepted
    await expectAcceptedRaw(chain, rawBuy(order, utxo, pool));
  });

  it('rejects received one below minOut at magnitude', () => {
    const { pool, order, utxo } = bigSetup(bigBest.tokensOut + 1n);
    expectCovenantRejects(rawBuy(order, utxo, pool), order, 'received below minOut', { poolPasses: true });
  });

  it('rejects leaving one token behind at magnitude', () => {
    const { pool, order, utxo } = bigSetup(1n);
    expectCovenantRejects(
      rawBuy(order, utxo, pool, { tokensOut: bigBest.tokensOut - 1n }),
      order,
      'fill leaves tokens in the pool',
      { poolPasses: true },
    );
  });

  it('rejects a fee one above the cap at magnitude', () => {
    const { pool, order, utxo } = bigSetup(1n);
    expectCovenantRejects(
      rawBuy(order, utxo, pool, { bchIn: BIG_VALUE - 1000n - MAX_FEE - 1n }),
      order,
      'network fee above maxNetworkFee',
      { poolPasses: true },
    );
  });
});
