import { hexToBin, type Output, type TransactionCommon } from '@bitauth/libauth';
import type { Utxo } from 'cashscript';
import { describe, expect, it } from 'vitest';
import { orderRedeemScript, type Order } from '@atprice/core';
import {
  CATEGORY,
  Chain,
  contractUnlock,
  orderParams,
  OWNER,
  rawTransaction,
  STRANGER,
  tokenOutput,
  type RawInput,
} from '../harness.js';
import {
  expectAcceptedRaw,
  expectCovenantRejects,
  p2pkhUnlock,
  signInput,
  SIGHASH_NONE_ANYONECANPAY,
  SIGHASH_SINGLE_ANYONECANPAY,
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
const cancelWithSigInput = (order: Order, utxo: OrderUtxo, signer = OWNER): RawInput => ({
  utxo,
  unlock: contractUnlock(order.contract.unlock.cancelWithSig(OWNER.publicKey, signer.signer)),
});

/** A refund output that mirrors `utxo` exactly, paid to `to`. */
const mirror = (utxo: Utxo, valueSatoshis: bigint, to = OWNER.lockingBytecode): Output => ({
  lockingBytecode: to,
  valueSatoshis,
  ...(utxo.token && {
    token: {
      category: hexToBin(utxo.token.category),
      amount: utxo.token.amount,
      ...(utxo.token.nft && {
        nft: { capability: utxo.token.nft.capability, commitment: hexToBin(utxo.token.nft.commitment) },
      }),
    },
  }),
});

describe('adversarial cancel(): positive control', () => {
  it('accepts a hand-built owner cancel of a buy and a sell (harness can accept)', async () => {
    const { chain, buy, sell, ownerUtxo } = fund();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(buy.order, buy.utxo), cancelInput(sell.order, sell.utxo)],
      [mirror(ownerUtxo, 1000n), mirror(buy.utxo, BUY_VALUE - 1000n), mirror(sell.utxo, 1500n)],
    );
    await expectAcceptedRaw(chain, built);
  });
});

describe('adversarial cancel(): rejected', () => {
  it('rejects the order at input 0', () => {
    const { buy, ownerUtxo } = fund();
    const built = rawTransaction(
      [cancelInput(buy.order, buy.utxo), ownerInput(ownerUtxo)],
      [mirror(buy.utxo, BUY_VALUE - 1000n), mirror(ownerUtxo, 1000n)],
    );
    expectCovenantRejects(built, buy.order, 'order cannot be input 0', { input: 0 });
  });

  it('rejects a stranger P2PKH at input 0', () => {
    const { chain, buy } = fund();
    const strangerUtxo = chain.addP2pkh(STRANGER, 1000n);
    const built = rawTransaction(
      [
        { utxo: strangerUtxo, unlock: contractUnlock(STRANGER.signer.unlockP2PKH()) },
        cancelInput(buy.order, buy.utxo),
      ],
      [mirror(strangerUtxo, 1000n, STRANGER.lockingBytecode), mirror(buy.utxo, BUY_VALUE - 1000n)],
    );
    expectCovenantRejects(built, buy.order, 'input 0 must be the owner');
  });

  it('rejects more outputs than inputs, even when the owner signs it', () => {
    const { buy, ownerUtxo } = fund();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(buy.order, buy.utxo)],
      [
        mirror(ownerUtxo, 1000n),
        mirror(buy.utxo, BUY_VALUE - 2000n),
        { lockingBytecode: STRANGER.lockingBytecode, valueSatoshis: 546n },
      ],
    );
    expectCovenantRejects(built, buy.order, 'too many outputs');
  });

  it('rejects a refund to a stranger', () => {
    const { buy, ownerUtxo } = fund();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(buy.order, buy.utxo)],
      [mirror(ownerUtxo, 1000n), mirror(buy.utxo, BUY_VALUE - 1000n, STRANGER.lockingBytecode)],
    );
    expectCovenantRejects(built, buy.order, 'refund must go to the owner');
  });

  it('rejects a refund one satoshi below V - maxNetworkFee', () => {
    const { buy, ownerUtxo } = fund();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(buy.order, buy.utxo)],
      [mirror(ownerUtxo, 1000n), mirror(buy.utxo, BUY_VALUE - MAX_FEE - 1n)],
    );
    expectCovenantRejects(built, buy.order, 'refund below value minus maxNetworkFee');
  });

  it('rejects a sell refund that drops one token', () => {
    const { sell, ownerUtxo } = fund();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(sell.order, sell.utxo)],
      [mirror(ownerUtxo, 1000n), tokenOutput(OWNER.lockingBytecode, 1500n, CATEGORY, SELL_TOKENS - 1n)],
    );
    expectCovenantRejects(built, sell.order, 'refund must keep the token amount');
  });

  it('rejects a sell refund that drops all tokens', () => {
    const { sell, ownerUtxo } = fund();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(sell.order, sell.utxo)],
      [mirror(ownerUtxo, 1000n), { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1500n }],
    );
    expectCovenantRejects(built, sell.order, 'refund must keep the token category');
  });
});

describe('adversarial cancel(): NFT at an order address', () => {
  const nftSetup = () => {
    const { chain, sell, ownerUtxo } = fund();
    const stray = chain.addUtxoAt(sell.order, {
      satoshis: 3000n,
      token: { category: CATEGORY, amount: 7n, nft: { capability: 'mutable', commitment: 'abcd' } },
    });
    return { chain, order: sell.order, stray, ownerUtxo };
  };
  const nftRefund = (capability: 'none' | 'mutable', commitment: string): Output => ({
    lockingBytecode: OWNER.lockingBytecode,
    valueSatoshis: 2000n,
    token: {
      category: hexToBin(CATEGORY),
      amount: 7n,
      nft: { capability, commitment: hexToBin(commitment) },
    },
  });

  it('accepts an exact mirror of a mutable NFT (control)', async () => {
    const { chain, order, stray, ownerUtxo } = nftSetup();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(order, stray)],
      [mirror(ownerUtxo, 1000n), nftRefund('mutable', 'abcd')],
    );
    await expectAcceptedRaw(chain, built);
  });

  it('rejects a refund that rewrites the NFT commitment', () => {
    const { order, stray, ownerUtxo } = nftSetup();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(order, stray)],
      [mirror(ownerUtxo, 1000n), nftRefund('mutable', 'abce')],
    );
    expectCovenantRejects(built, order, 'refund must keep the NFT commitment');
  });

  it('rejects a refund that downgrades the NFT capability', () => {
    const { order, stray, ownerUtxo } = nftSetup();
    const built = rawTransaction(
      [ownerInput(ownerUtxo), cancelInput(order, stray)],
      [mirror(ownerUtxo, 1000n), nftRefund('none', 'abcd')],
    );
    expectCovenantRejects(built, order, 'refund must keep the token category');
  });
});

describe('adversarial cancelWithSig()', () => {
  it('accepts a hand-built owner-signed refund (control)', async () => {
    const { chain, buy } = fund();
    const built = rawTransaction(
      [cancelWithSigInput(buy.order, buy.utxo)],
      [mirror(buy.utxo, BUY_VALUE - 1000n)],
    );
    await expectAcceptedRaw(chain, built);
  });

  it('rejects the owner public key with a stranger signature', () => {
    const { buy } = fund();
    const built = rawTransaction(
      [cancelWithSigInput(buy.order, buy.utxo, STRANGER)],
      [mirror(buy.utxo, BUY_VALUE - 1000n)],
    );
    expectCovenantRejects(built, buy.order, 'invalid owner signature', { input: 0 });
  });

  it('rejects outputs = inputs + 2', () => {
    const { buy } = fund();
    const built = rawTransaction(
      [cancelWithSigInput(buy.order, buy.utxo)],
      [
        mirror(buy.utxo, BUY_VALUE - 2000n),
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 546n },
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 546n },
      ],
    );
    expectCovenantRejects(built, buy.order, 'too many outputs', { input: 0 });
  });

  it('rejects an owner signature replayed onto a refund changed by one satoshi', () => {
    const { buy } = fund();
    const signed = rawTransaction(
      [cancelWithSigInput(buy.order, buy.utxo)],
      [mirror(buy.utxo, BUY_VALUE - 1000n)],
    );
    const tampered: TransactionCommon = {
      ...signed.transaction,
      outputs: [mirror(buy.utxo, BUY_VALUE - 1001n)],
    };
    expectCovenantRejects(
      { transaction: tampered, sourceOutputs: signed.sourceOutputs },
      buy.order,
      'invalid owner signature',
      {
        input: 0,
      },
    );
  });

  it("rejects one order's cancel signature replayed onto another order of the same owner", () => {
    const { chain, buy } = fund();
    const twin = chain.addOrder(orderParams('buy', { nonce: Uint8Array.of(7, 7, 7, 7, 7, 7, 7, 7) }), {
      satoshis: BUY_VALUE,
    });
    const signed = rawTransaction(
      [cancelWithSigInput(buy.order, buy.utxo)],
      [mirror(buy.utxo, BUY_VALUE - 1000n)],
    );
    const unlocking = signed.transaction.inputs[0]?.unlockingBytecode ?? new Uint8Array();
    const sigPush = unlocking.slice(0, 66);
    const replayed = rawTransaction(
      [
        {
          utxo: twin.utxo,
          unlock: (tx, so, index) => {
            const fresh = contractUnlock(
              twin.order.contract.unlock.cancelWithSig(OWNER.publicKey, OWNER.signer),
            )(tx, so, index);
            return Uint8Array.from([...sigPush, ...fresh.slice(66)]);
          },
        },
      ],
      [mirror(twin.utxo, BUY_VALUE - 1000n)],
    );
    expect(replayed.transaction.inputs[0]?.unlockingBytecode.slice(0, 66)).toEqual(sigPush);
    expectCovenantRejects(replayed, twin.order, 'invalid owner signature', { input: 0 });
  });
});

describe('adversarial cancel paths: exposure when the owner signs a non-ALL hash type (advisory)', () => {
  it('documents: a SIGHASH_NONE|ANYONECANPAY cancelWithSig lets a third party redirect up to maxNetworkFee, and not one satoshi more', async () => {
    // #given an owner signature over only the order input (NONE|ANYONECANPAY)
    const { chain, buy } = fund();
    const redeem = orderRedeemScript(buy.order.params);
    const weakSig: RawInput['unlock'] = (tx, so, index) => {
      const sig = signInput(OWNER, tx, so, index, redeem, SIGHASH_NONE_ANYONECANPAY);
      return contractUnlock(buy.order.contract.unlock.cancelWithSig(OWNER.publicKey, sig))(tx, so, index);
    };
    const theft = (taken: bigint) =>
      rawTransaction(
        [{ utxo: buy.utxo, unlock: weakSig }],
        [
          mirror(buy.utxo, BUY_VALUE - taken),
          { lockingBytecode: STRANGER.lockingBytecode, valueSatoshis: taken - 500n },
        ],
      );
    // #then one satoshi beyond the allowance is refused by the refund rule
    expectCovenantRejects(theft(MAX_FEE + 1n), buy.order, 'refund below value minus maxNetworkFee', {
      input: 0,
    });
    // #then exactly the allowance (minus the miner fee) can be redirected to a stranger
    await expectAcceptedRaw(chain, theft(MAX_FEE));
  });

  it('documents: an owner input signed SINGLE|ANYONECANPAY elsewhere lets a third party force a cancel (refund still to the owner)', async () => {
    const { chain, buy, ownerUtxo } = fund();
    const built = rawTransaction(
      [
        { utxo: ownerUtxo, unlock: p2pkhUnlock(OWNER, SIGHASH_SINGLE_ANYONECANPAY) },
        cancelInput(buy.order, buy.utxo),
      ],
      [mirror(ownerUtxo, 1000n), mirror(buy.utxo, BUY_VALUE - MAX_FEE)],
    );
    await expectAcceptedRaw(chain, built);
  });
});
