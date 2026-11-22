import { hexToBin, type Output } from '@bitauth/libauth';
import type { Utxo } from 'cashscript';
import { describe, expect, it } from 'vitest';
import type { Order } from '@atprice/core';
import {
  CATEGORY,
  Chain,
  contractUnlock,
  orderParams,
  OWNER,
  rawTransaction,
  STRANGER,
  tokenOutput,
  type Key,
  type RawInput,
} from '../harness.js';
import {
  evaluateInput,
  expectAcceptedRaw,
  expectCovenantRejects,
  verifyAll,
  type OrderUtxo,
} from './support.js';

const BUY_VALUE = 10_003_000n;
const MAX_FEE = 2000n;
const SELL_TOKENS = 5_000n;

const fund = () => {
  const chain = new Chain();
  const buy = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
  const sell = chain.addOrder(orderParams('sell'), {
    satoshis: 2000n,
    token: { category: CATEGORY, amount: SELL_TOKENS },
  });
  const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
  return { chain, buy, sell, ownerUtxo };
};

const ownerInput = (utxo: OrderUtxo): RawInput => ({
  utxo,
  unlock: contractUnlock(OWNER.signer.unlockP2PKH()),
});
const cancelInput = (order: Order, utxo: OrderUtxo): RawInput => ({
  utxo,
  unlock: contractUnlock(order.contract.unlock.cancel()),
});
const withSig = (order: Order, utxo: OrderUtxo, pubkeyOf: Key = OWNER, signer: Key = OWNER): RawInput => ({
  utxo,
  unlock: contractUnlock(order.contract.unlock.cancelWithSig(pubkeyOf.publicKey, signer.signer)),
});

const mirror = (utxo: Utxo, valueSatoshis: bigint, to = OWNER.lockingBytecode): Output => ({
  lockingBytecode: to,
  valueSatoshis,
  ...(utxo.token && {
    token: { category: hexToBin(utxo.token.category), amount: utxo.token.amount },
  }),
});

describe('adversarial cancelWithSig(): rule R holds even over a valid owner signature', () => {
  it('positive control: an owner-signed refund of exactly V - maxNetworkFee is accepted (buy)', async () => {
    const { chain, buy } = fund();
    await expectAcceptedRaw(
      chain,
      rawTransaction([withSig(buy.order, buy.utxo)], [mirror(buy.utxo, BUY_VALUE - MAX_FEE)]),
    );
  });

  it('positive control: an owner-signed sell refund with every token is accepted', async () => {
    const { chain, sell } = fund();
    await expectAcceptedRaw(
      chain,
      rawTransaction([withSig(sell.order, sell.utxo)], [mirror(sell.utxo, 1200n)]),
    );
  });

  it('rejects an owner-signed refund one satoshi below V - maxNetworkFee', () => {
    const { buy } = fund();
    const built = rawTransaction(
      [withSig(buy.order, buy.utxo)],
      [mirror(buy.utxo, BUY_VALUE - MAX_FEE - 1n)],
    );
    expectCovenantRejects(built, buy.order, 'refund below value minus maxNetworkFee', { input: 0 });
  });

  it('rejects an owner-signed refund to a stranger', () => {
    const { buy } = fund();
    const built = rawTransaction(
      [withSig(buy.order, buy.utxo)],
      [mirror(buy.utxo, BUY_VALUE - 1000n, STRANGER.lockingBytecode)],
    );
    expectCovenantRejects(built, buy.order, 'refund must go to the owner', { input: 0 });
  });

  it('rejects an owner-signed sell refund that drops one token', () => {
    const { sell } = fund();
    const built = rawTransaction(
      [withSig(sell.order, sell.utxo)],
      [tokenOutput(OWNER.lockingBytecode, 1500n, CATEGORY, SELL_TOKENS - 1n)],
    );
    expectCovenantRejects(built, sell.order, 'refund must keep the token amount', { input: 0 });
  });

  it('rejects an owner-signed sell refund that drops every token', () => {
    const { sell } = fund();
    const built = rawTransaction(
      [withSig(sell.order, sell.utxo)],
      [{ lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1500n }],
    );
    expectCovenantRejects(built, sell.order, 'refund must keep the token category', { input: 0 });
  });

  it('rejects a stranger key and a stranger signature in a cancel shape', () => {
    const { buy } = fund();
    const built = rawTransaction(
      [withSig(buy.order, buy.utxo, STRANGER, STRANGER)],
      [mirror(buy.utxo, BUY_VALUE - 1000n)],
    );
    expectCovenantRejects(built, buy.order, 'not the owner key', { input: 0 });
  });
});

describe('adversarial batch cancels: index games', () => {
  it('positive control: two orders cancelled with cancelWithSig and one extra owner output (outputs = inputs + 1)', async () => {
    const { chain, buy, sell } = fund();
    const built = rawTransaction(
      [withSig(buy.order, buy.utxo), withSig(sell.order, sell.utxo)],
      [
        mirror(buy.utxo, BUY_VALUE - 1500n),
        mirror(sell.utxo, 1500n),
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 546n },
      ],
    );
    await expectAcceptedRaw(chain, built);
  });

  it('rejects cancel() of two orders where the second refund is missing', () => {
    // #given an owner-signed cancel() whose outputs stop before the second order's index
    const { buy, sell, ownerUtxo } = fund();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(buy.order, buy.utxo), cancelInput(sell.order, sell.utxo)],
      [mirror(ownerUtxo, 1000n), mirror(buy.utxo, BUY_VALUE - 1000n)],
    );
    // #then the first order passes on its own and the second fails reading output 2
    expect(verifyAll(built.transaction, built.sourceOutputs)).not.toBe(true);
    expect(evaluateInput(built.transaction, built.sourceOutputs, 1, buy.order.contract.artifact)).toEqual({
      ok: true,
    });
    const verdict = evaluateInput(built.transaction, built.sourceOutputs, 2, sell.order.contract.artifact);
    expect(verdict.ok).toBe(false);
  });

  it('rejects cancel() of a buy and a sell with their refunds swapped', () => {
    const { buy, sell, ownerUtxo } = fund();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(buy.order, buy.utxo), cancelInput(sell.order, sell.utxo)],
      [mirror(ownerUtxo, 1000n), mirror(sell.utxo, 1500n), mirror(buy.utxo, BUY_VALUE - 1000n)],
    );
    expectCovenantRejects(built, buy.order, 'refund must keep the token category', { input: 1 });
    expectCovenantRejects(built, sell.order, 'refund must keep the token category', { input: 2 });
  });

  it("rejects cancel() where a second order borrows the first order's refund index (two inputs, one refund)", () => {
    // #given two buy orders of the owner at inputs 1 and 2 but only one refund (output 1) carrying both values
    const { chain, buy, ownerUtxo } = fund();
    const twin = chain.addOrder(orderParams('buy', { nonce: Uint8Array.of(7, 7, 7, 7, 7, 7, 7, 7) }), {
      satoshis: BUY_VALUE,
    });
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(buy.order, buy.utxo), cancelInput(twin.order, twin.utxo)],
      [
        mirror(ownerUtxo, 1000n),
        mirror(buy.utxo, BUY_VALUE - 1000n),
        { lockingBytecode: STRANGER.lockingBytecode, valueSatoshis: BUY_VALUE - 1000n },
      ],
    );
    // #then the twin's refund rule fires on output 2, which goes to the stranger
    expectCovenantRejects(built, twin.order, 'refund must go to the owner', { input: 2 });
  });
});
