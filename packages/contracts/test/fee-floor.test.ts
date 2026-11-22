import { describe, expect, it } from 'vitest';
import {
  buildExecuteTransaction,
  buyFill,
  MAX_NETWORK_FEE_FLOOR,
  MEASURED_EXECUTE_SIZES,
  sellFill,
  type OrderParams,
  type PoolReserves,
} from '@atprice/core';
import { CATEGORY, Chain, orderParams, OWNER, P2SH32_RECIPIENT } from './harness.js';

/**
 * Worst-case encodings for the floor (contract spec, `maxNetworkFee` row): 9-byte token amounts on
 * pool input, pool output and payout, and the longest realistic minOut push. A buy minOut is a token
 * amount, so it reaches 8 bytes (>= 2^55). A sell minOut is satoshis and cannot exceed 21M BCH
 * (< 2^51), so its longest push is 7 bytes.
 */
const BUY_POOL: PoolReserves = { sats: 100_000_000n, tokens: 2n ** 62n - 1n };
const BUY_SPEND = 100_000_000n;
const SELL_POOL: PoolReserves = { sats: 2n ** 50n, tokens: 2n ** 40n };
const SELL_TOKENS = 2n ** 39n;

const scriptNumberLength = (value: bigint): number => {
  let length = 0;
  for (let rest = value; rest > 0n; rest >>= 8n) length += 1;
  return (value >> BigInt(length * 8 - 1)) & 1n ? length + 1 : length;
};

const measureBuy = async (recipient: Uint8Array, fee: bigint): Promise<number> => {
  const chain = new Chain();
  const pool = chain.addPool(BUY_POOL);
  const minOut = buyFill(BUY_POOL, BUY_SPEND).tokensOut;
  expect(scriptNumberLength(minOut)).toBe(8);
  const params: OrderParams = orderParams('buy', {
    recipientLockingBytecode: recipient,
    minOut,
    maxNetworkFee: MAX_NETWORK_FEE_FLOOR,
  });
  const { order, utxo } = chain.addOrder(params, { satoshis: BUY_SPEND + 1000n + MAX_NETWORK_FEE_FLOOR });
  const tx = buildExecuteTransaction(order, utxo, pool, { fee: { kind: 'absolute', satoshis: fee } });
  const { size } = await chain.expectAccepted(tx.hex, tx.sourceOutputs);
  return size;
};

const measureSell = async (recipient: Uint8Array, fee: bigint): Promise<number> => {
  const chain = new Chain();
  const pool = chain.addPool(SELL_POOL);
  const minOut = sellFill(SELL_POOL, SELL_TOKENS).bchOut + 2000n - fee;
  expect(scriptNumberLength(minOut)).toBe(7);
  const params: OrderParams = orderParams('sell', {
    recipientLockingBytecode: recipient,
    minOut,
    maxNetworkFee: MAX_NETWORK_FEE_FLOOR,
  });
  const { order, utxo } = chain.addOrder(params, {
    satoshis: 2000n,
    token: { category: CATEGORY, amount: SELL_TOKENS },
  });
  const tx = buildExecuteTransaction(order, utxo, pool, { fee: { kind: 'absolute', satoshis: fee } });
  const { size } = await chain.expectAccepted(tx.hex, tx.sourceOutputs);
  return size;
};

/** Spec formula: size * 1 sat/B, plus 20%, rounded up to a multiple of 100. */
const floorFor = (size: number): bigint => {
  const withMargin = (BigInt(size) * 12n + 9n) / 10n;
  return ((withMargin + 99n) / 100n) * 100n;
};

describe('maxNetworkFee floor (D-012)', () => {
  it('fills at exactly the floor with a P2SH32 recipient, passing the standard VM at >= 1 sat/B', async () => {
    const buy = await measureBuy(P2SH32_RECIPIENT, MAX_NETWORK_FEE_FLOOR);
    const sell = await measureSell(P2SH32_RECIPIENT, MAX_NETWORK_FEE_FLOOR);
    expect(BigInt(buy) <= MAX_NETWORK_FEE_FLOOR && BigInt(sell) <= MAX_NETWORK_FEE_FLOOR).toBe(true);
  });

  it('matches the recorded worst-case sizes and the floor formula', async () => {
    const measured = {
      buyP2pkh: await measureBuy(OWNER.lockingBytecode, MAX_NETWORK_FEE_FLOOR),
      buyP2sh32: await measureBuy(P2SH32_RECIPIENT, MAX_NETWORK_FEE_FLOOR),
      sellP2pkh: await measureSell(OWNER.lockingBytecode, MAX_NETWORK_FEE_FLOOR),
      sellP2sh32: await measureSell(P2SH32_RECIPIENT, MAX_NETWORK_FEE_FLOOR),
    };
    console.info('execute sizes (bytes)', measured);
    expect(measured).toEqual(MEASURED_EXECUTE_SIZES);
    const largest = Math.max(...Object.values(measured));
    expect(floorFor(largest)).toBe(MAX_NETWORK_FEE_FLOOR);
  });
});
