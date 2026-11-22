import { binToHex, encodeLockingBytecodeP2sh32, hash256, hexToBin } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import {
  buildExecuteTransaction,
  buyFill,
  OrderNotExecutableError,
  poolUnlockingBytecode,
  sellFill,
  type CauldronPoolUtxo,
  type Order,
  type PoolReserves,
} from '@atprice/core';
import {
  CATEGORY,
  Chain,
  contractUnlock,
  decode,
  expectRejected,
  OTHER_CATEGORY,
  OTHER_POOL_OWNER,
  orderParams,
  OWNER,
  P2SH32_RECIPIENT,
  poolOutput,
  rawTransaction,
  STRANGER,
  TOKEN_CONSENSUS_ERROR,
  tokenOutput,
  type RawInput,
} from './harness.js';

const POOL: PoolReserves = { sats: 150_545_039n, tokens: 29_857n };
const SPEND = 10_000_000n;
const BUY_VALUE = SPEND + 1000n + 2000n;

type OrderUtxo = RawInput['utxo'];

const poolInput = (pool: CauldronPoolUtxo): RawInput => ({
  utxo: { ...pool, lockingBytecode: pool.lockingBytecode ?? '' },
  unlock: poolUnlockingBytecode(pool.ownerPkh),
});
const orderInput = (order: Order, utxo: OrderUtxo, poolPkh: Uint8Array): RawInput => ({
  utxo,
  unlock: contractUnlock(order.contract.unlock.execute(poolPkh)),
});

/** A buy fill assembled by hand: `bchIn` into the pool, `tokensOut` to `recipient`. */
const rawBuy = (
  order: Order,
  utxo: OrderUtxo,
  pool: CauldronPoolUtxo,
  overrides: { bchIn?: bigint; tokensOut?: bigint; recipient?: Uint8Array; version?: number } = {},
): ReturnType<typeof rawTransaction> => {
  const bchIn = overrides.bchIn ?? utxo.satoshis - 1000n - 1000n;
  const tokensOut =
    overrides.tokensOut ?? buyFill({ sats: pool.satoshis, tokens: pool.token.amount }, bchIn).tokensOut;
  return rawTransaction(
    [poolInput(pool), orderInput(order, utxo, pool.ownerPkh)],
    [
      poolOutput(pool, { sats: pool.satoshis + bchIn, tokens: pool.token.amount - tokensOut }),
      tokenOutput(overrides.recipient ?? order.params.recipientLockingBytecode, 1000n, CATEGORY, tokensOut),
    ],
    overrides.version,
  );
};

/** A sell fill assembled by hand: `bchOut` out of the pool, `payout` to the recipient. */
const rawSell = (
  order: Order,
  utxo: OrderUtxo,
  pool: CauldronPoolUtxo,
  overrides: { bchOut?: bigint; payout?: bigint } = {},
): ReturnType<typeof rawTransaction> => {
  const tokensIn = utxo.token?.amount ?? 0n;
  const bchOut =
    overrides.bchOut ?? sellFill({ sats: pool.satoshis, tokens: pool.token.amount }, tokensIn).bchOut;
  const payout = overrides.payout ?? bchOut + utxo.satoshis - 1000n;
  return rawTransaction(
    [poolInput(pool), orderInput(order, utxo, pool.ownerPkh)],
    [
      poolOutput(pool, { sats: pool.satoshis - bchOut, tokens: pool.token.amount + tokensIn }),
      { lockingBytecode: order.params.recipientLockingBytecode, valueSatoshis: payout },
    ],
  );
};

describe('AtPriceBuy.execute (accepted)', () => {
  it('fills a buy through a real Cauldron pool and pays every released token to the recipient', async () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const { order, utxo } = chain.addOrder(orderParams('buy', { minOut: 1800n }), { satoshis: BUY_VALUE });
    const tx = buildExecuteTransaction(order, utxo, pool);
    expect(tx.execution.side).toBe('buy');
    const { fee, size } = await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    expect(fee).toBe(tx.fee);
    expect(size).toBe(tx.size);
    expect(tx.fee).toBeLessThanOrEqual(order.params.maxNetworkFee);
    const payout = decode(tx.hex).outputs[1];
    expect(payout?.token?.amount).toBe(tx.execution.side === 'buy' ? tx.execution.tokensOut : -1n);
    expect(decode(tx.hex).inputs[0]?.unlockingBytecode.length).toBe(69);
  });

  it('accepts minOut exactly equal to the tokens released', async () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const probe = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    const expected = buildExecuteTransaction(probe.order, probe.utxo, pool);
    if (expected.execution.side !== 'buy') throw new Error('expected a buy');
    const { order, utxo } = chain.addOrder(orderParams('buy', { minOut: expected.execution.tokensOut }), {
      satoshis: BUY_VALUE,
    });
    const tx = buildExecuteTransaction(order, utxo, pool);
    expect(tx.execution.surplus).toBe(0n);
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
  });

  it('accepts a network fee exactly equal to maxNetworkFee', async () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const { order, utxo } = chain.addOrder(orderParams('buy', { maxNetworkFee: 1500n }), {
      satoshis: SPEND + 1000n + 1500n,
    });
    const tx = buildExecuteTransaction(order, utxo, pool, { fee: { kind: 'absolute', satoshis: 1500n } });
    expect(tx.fee).toBe(1500n);
    expect(tx.execution.side === 'buy' && tx.execution.bchIn).toBe(SPEND);
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
  });

  it('accepts a P2SH32 recipient', async () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const { order, utxo } = chain.addOrder(
      orderParams('buy', { recipientLockingBytecode: P2SH32_RECIPIENT }),
      { satoshis: BUY_VALUE },
    );
    const tx = buildExecuteTransaction(order, utxo, pool);
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    expect(decode(tx.hex).outputs[1]?.lockingBytecode).toEqual(P2SH32_RECIPIENT);
  });

  it('stays exact at magnitude (B0*T0 > 2^100)', async () => {
    const chain = new Chain();
    const reserves = { sats: 2n ** 45n, tokens: 2n ** 62n - 1n };
    expect(reserves.sats * reserves.tokens > 2n ** 100n).toBe(true);
    const pool = chain.addPool(reserves);
    const { order, utxo } = chain.addOrder(orderParams('buy'), { satoshis: 2n ** 44n });
    const tx = buildExecuteTransaction(order, utxo, pool);
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
  });
});

describe('AtPriceBuy.execute (rejected)', () => {
  const setup = () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const order = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    return { chain, pool, ...order };
  };

  it('accepts the unmodified hand-built fill (control for the cases below)', async () => {
    const { chain, pool, order, utxo } = setup();
    const { hex, sourceOutputs } = rawBuy(order, utxo, pool);
    await chain.expectAccepted(hex, sourceOutputs);
  });

  it('rejects a fake pool (P2SH32 of another script)', () => {
    const { chain, order, utxo } = setup();
    const fakeScript = Uint8Array.of(0x51);
    const fakeLocking = encodeLockingBytecodeP2sh32(hash256(fakeScript));
    const fake = chain.provider.addUtxo(binToHex(fakeLocking), {
      txid: utxo.txid.replace(/^../, 'ee'),
      vout: 0,
      satoshis: POOL.sats,
      token: { category: CATEGORY, amount: POOL.tokens },
    });
    const bchIn = BUY_VALUE - 2000n;
    const fill = buyFill(POOL, bchIn);
    const { transaction, sourceOutputs } = rawTransaction(
      [
        { utxo: { ...fake, lockingBytecode: binToHex(fakeLocking) }, unlock: Uint8Array.of(0x01, 0x51) },
        orderInput(order, utxo, OTHER_POOL_OWNER.pkh),
      ],
      [
        {
          lockingBytecode: fakeLocking,
          valueSatoshis: fill.poolAfter.sats,
          token: { category: hexToBin(CATEGORY), amount: fill.poolAfter.tokens },
        },
        tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, fill.tokensOut),
      ],
    );
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects payout one token below minOut', () => {
    const { chain, pool } = setup();
    const bchIn = BUY_VALUE - 2000n;
    const tokensOut = buyFill(POOL, bchIn).tokensOut;
    const { order, utxo } = chain.addOrder(orderParams('buy', { minOut: tokensOut + 1n }), {
      satoshis: BUY_VALUE,
    });
    expect(() => buildExecuteTransaction(order, utxo, pool)).toThrow(OrderNotExecutableError);
    const { transaction, sourceOutputs } = rawBuy(order, utxo, pool, { bchIn });
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects a network fee one above maxNetworkFee', () => {
    const { pool, order, utxo } = setup();
    const { transaction, sourceOutputs } = rawBuy(order, utxo, pool, { bchIn: BUY_VALUE - 1000n - 2001n });
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects a fill that leaves one token in the pool', () => {
    const { pool, order, utxo } = setup();
    const bchIn = BUY_VALUE - 2000n;
    const { transaction, sourceOutputs } = rawBuy(order, utxo, pool, {
      bchIn,
      tokensOut: buyFill(POOL, bchIn).tokensOut - 1n,
    });
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects a wrong recipient', () => {
    const { pool, order, utxo } = setup();
    const { transaction, sourceOutputs } = rawBuy(order, utxo, pool, { recipient: STRANGER.lockingBytecode });
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects tx.version 1', () => {
    const { pool, order, utxo } = setup();
    const { transaction, sourceOutputs } = rawBuy(order, utxo, pool, { version: 1 });
    expectRejected(transaction, sourceOutputs);
  });

  it('rejects a real pool of another token', () => {
    const { chain, order, utxo } = setup();
    const other = chain.addPool(POOL, { category: OTHER_CATEGORY });
    expect(() => buildExecuteTransaction(order, utxo, other)).toThrow(/pool holds/);
    const bchIn = BUY_VALUE - 2000n;
    const tokensOut = buyFill(POOL, bchIn).tokensOut;
    const { transaction, sourceOutputs } = rawTransaction(
      [poolInput(other), orderInput(order, utxo, other.ownerPkh)],
      [
        poolOutput(other, { sats: POOL.sats + bchIn, tokens: POOL.tokens - tokensOut }),
        tokenOutput(OWNER.lockingBytecode, 1000n, OTHER_CATEGORY, tokensOut),
      ],
    );
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects the pool spent through its withdraw branch', () => {
    const { chain, order, utxo } = setup();
    const pool = chain.addPool(POOL, { owner: OTHER_POOL_OWNER });
    const { transaction, sourceOutputs } = rawBuy(order, utxo, pool);
    const withdraw = Uint8Array.of(0x51, ...(transaction.inputs[0]?.unlockingBytecode ?? []));
    const tampered = {
      ...transaction,
      inputs: transaction.inputs.map((input, index) =>
        index === 0 ? { ...input, unlockingBytecode: withdraw } : input,
      ),
    };
    expectRejected(tampered, sourceOutputs);
  });

  it('rejects an order at input 0', () => {
    const { pool, order, utxo } = setup();
    const bchIn = BUY_VALUE - 2000n;
    const fill = buyFill(POOL, bchIn);
    const { transaction, sourceOutputs } = rawTransaction(
      [{ utxo, unlock: contractUnlock(order.contract.unlock.execute(pool.ownerPkh)) }, poolInput(pool)],
      [tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, fill.tokensOut), poolOutput(pool, fill.poolAfter)],
    );
    expectRejected(transaction, sourceOutputs, 0);
  });

  it('rejects a third output', () => {
    const { pool, order, utxo } = setup();
    const built = rawBuy(order, utxo, pool, { bchIn: BUY_VALUE - 3000n });
    const extra = {
      ...built.transaction,
      outputs: [
        ...built.transaction.outputs,
        { lockingBytecode: STRANGER.lockingBytecode, valueSatoshis: 1000n },
      ],
    };
    expectRejected(extra, built.sourceOutputs, 1);
  });
});

describe('AtPriceBuy.execute (rejected shapes and token rules)', () => {
  const setup = () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const order = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    const bchIn = BUY_VALUE - 2000n;
    return { chain, pool, ...order, bchIn, fill: buyFill(POOL, bchIn) };
  };

  it('rejects a third input at the order input', () => {
    const { chain, pool, order, utxo, fill } = setup();
    const extra = chain.addP2pkh(STRANGER, 5000n);
    const { transaction, sourceOutputs } = rawTransaction(
      [
        poolInput(pool),
        orderInput(order, utxo, pool.ownerPkh),
        { utxo: extra, unlock: contractUnlock(STRANGER.signer.unlockP2PKH()) },
      ],
      [poolOutput(pool, fill.poolAfter), tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, fill.tokensOut)],
    );
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects the pool output redirected to the attacker, at the pool input', () => {
    const { pool, order, utxo, fill } = setup();
    const { transaction, sourceOutputs } = rawTransaction(
      [poolInput(pool), orderInput(order, utxo, pool.ownerPkh)],
      [
        tokenOutput(STRANGER.lockingBytecode, fill.poolAfter.sats, CATEGORY, fill.poolAfter.tokens),
        tokenOutput(OWNER.lockingBytecode, 1000n, CATEGORY, fill.tokensOut),
      ],
    );
    expectRejected(transaction, sourceOutputs, 0);
  });

  it('rejects a token-less payout (released tokens burned) at the order input', () => {
    const { pool, order, utxo, fill } = setup();
    const { transaction, sourceOutputs } = rawTransaction(
      [poolInput(pool), orderInput(order, utxo, pool.ownerPkh)],
      [poolOutput(pool, fill.poolAfter), { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n }],
    );
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects a payout of another category (token consensus)', () => {
    const { pool, order, utxo, fill } = setup();
    const { transaction, sourceOutputs } = rawTransaction(
      [poolInput(pool), orderInput(order, utxo, pool.ownerPkh)],
      [
        poolOutput(pool, fill.poolAfter),
        tokenOutput(OWNER.lockingBytecode, 1000n, OTHER_CATEGORY, fill.tokensOut),
      ],
    );
    const error = expectRejected(transaction, sourceOutputs);
    expect(error).toMatch(TOKEN_CONSENSUS_ERROR);
    expect(error).toContain('without a matching genesis input');
  });

  it('rejects a buy order UTXO that carries tokens, at the order input', () => {
    const { chain, pool, order } = setup();
    const tokenBearing = chain.addUtxoAt(order, {
      satoshis: BUY_VALUE,
      token: { category: CATEGORY, amount: 5n },
    });
    expect(() => buildExecuteTransaction(order, tokenBearing, pool)).toThrow(OrderNotExecutableError);
    const { transaction, sourceOutputs } = rawBuy(order, tokenBearing, pool);
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects only part of the order BCH going into the pool, the rest to the miner', () => {
    const { pool, order, utxo } = setup();
    const { transaction, sourceOutputs } = rawBuy(order, utxo, pool, { bchIn: SPEND / 2n });
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects only part of the order BCH going into the pool, the rest to the payout', () => {
    const { pool, order, utxo } = setup();
    const bchIn = SPEND / 2n;
    const fill = buyFill(POOL, bchIn);
    const { transaction, sourceOutputs } = rawTransaction(
      [poolInput(pool), orderInput(order, utxo, pool.ownerPkh)],
      [
        poolOutput(pool, fill.poolAfter),
        tokenOutput(OWNER.lockingBytecode, BUY_VALUE - bchIn - 1000n, CATEGORY, fill.tokensOut),
      ],
    );
    expectRejected(transaction, sourceOutputs, 1);
  });
});

describe('AtPriceSell.execute', () => {
  const TOKENS_IN = 1000n;

  it('fills a sell through a real Cauldron pool', async () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const { order, utxo } = chain.addOrder(orderParams('sell', { minOut: 4_000_000n }), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN },
    });
    const tx = buildExecuteTransaction(order, utxo, pool);
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    if (tx.execution.side !== 'sell') throw new Error('expected a sell');
    expect(tx.execution.bchOut).toBe(4_864_204n);
    expect(tx.execution.payoutSatoshis).toBe(4_864_204n + 2000n - tx.fee);
    expect(decode(tx.hex).outputs[1]?.token).toBeUndefined();
  });

  it('accepts a payout of exactly P + 2000 and rejects P + 1999', async () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const fee = 1000n;
    const bchOut = sellFill(POOL, TOKENS_IN).bchOut;
    const netProceeds = bchOut - fee;
    const minOut = netProceeds + 2000n;
    const { order, utxo } = chain.addOrder(orderParams('sell', { minOut }), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN },
    });

    const exact = buildExecuteTransaction(order, utxo, pool, { fee: { kind: 'absolute', satoshis: fee } });
    expect(exact.execution.payoutSatoshis).toBe(netProceeds + 2000n);
    expect(exact.execution.surplus).toBe(0n);
    expect(() =>
      buildExecuteTransaction(order, utxo, pool, { fee: { kind: 'absolute', satoshis: fee + 1n } }),
    ).toThrow(OrderNotExecutableError);
    const short = rawSell(order, utxo, pool, { payout: netProceeds + 1999n });
    expectRejected(short.transaction, short.sourceOutputs, 1);
    await chain.expectAccepted(exact.hex, exact.sourceOutputs);
  });

  it('accepts a fee exactly at maxNetworkFee and rejects one more', async () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const { order, utxo } = chain.addOrder(orderParams('sell'), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN },
    });
    const bchOut = sellFill(POOL, TOKENS_IN).bchOut;
    const over = rawSell(order, utxo, pool, { payout: bchOut + 2000n - 2001n });
    expectRejected(over.transaction, over.sourceOutputs, 1);
    const atCap = buildExecuteTransaction(order, utxo, pool, { fee: { kind: 'absolute', satoshis: 2000n } });
    expect(atCap.execution.payoutSatoshis).toBe(bchOut);
    await chain.expectAccepted(atCap.hex, atCap.sourceOutputs);
  });

  it('rejects a fill that leaves one satoshi in the pool', () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const { order, utxo } = chain.addOrder(orderParams('sell'), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN },
    });
    const bchOut = sellFill(POOL, TOKENS_IN).bchOut - 1n;
    const { transaction, sourceOutputs } = rawSell(order, utxo, pool, { bchOut, payout: bchOut + 1000n });
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects a sell order input of the wrong category', () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const { order } = chain.addOrder(orderParams('sell'), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: TOKENS_IN },
    });
    const stray = chain.addUtxoAt(order, {
      satoshis: 2000n,
      token: { category: OTHER_CATEGORY, amount: TOKENS_IN },
    });
    expect(() => buildExecuteTransaction(order, stray, pool)).toThrow(OrderNotExecutableError);
    // The stray tokens cannot reach the pool (its category is fixed), so they are burned and the pool is unchanged.
    const { transaction, sourceOutputs } = rawTransaction(
      [poolInput(pool), orderInput(order, stray, pool.ownerPkh)],
      [poolOutput(pool, POOL), { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n }],
    );
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('builder refuses a sell with no BCH left for the pool output dust', () => {
    const chain = new Chain();
    const pool = chain.addPool({ sats: 1500n, tokens: 10n });
    const { order, utxo } = chain.addOrder(orderParams('sell'), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: 10n ** 9n },
    });
    expect(() => buildExecuteTransaction(order, utxo, pool)).toThrow(OrderNotExecutableError);
    expect(hexToBin(pool.lockingBytecode ?? '').length).toBe(35);
  });
});
