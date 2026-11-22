import { binToHex, getDustThreshold, hexToBin, type Output } from '@bitauth/libauth';
import { TransactionBuilder, type Utxo } from 'cashscript';
import { describe, expect, it } from 'vitest';
import {
  buildSignedCancelTransaction,
  buildSignedCancelWithSigTransaction,
  OwnerUtxoRequiredError,
  TransactionBuildError,
  type CancelableOrder,
} from '@atprice/core';
import {
  CATEGORY,
  Chain,
  contractUnlock,
  decode,
  expectRejected,
  OTHER_CATEGORY,
  orderParams,
  OWNER,
  rawTransaction,
  sourceOutputOf,
  STRANGER,
  TOKEN_CONSENSUS_ERROR,
  tokenOutput,
  type RawInput,
} from './harness.js';

const BUY_VALUE = 10_003_000n;
const SELL_TOKENS = { category: CATEGORY, amount: 5_000n };

const ownerP2pkhInput = (utxo: Utxo & { lockingBytecode: string }): RawInput => ({
  utxo,
  unlock: contractUnlock(OWNER.signer.unlockP2PKH()),
});

const fundedOrders = (chain: Chain) => ({
  buy: chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE }),
  sell: chain.addOrder(orderParams('sell'), { satoshis: 2000n, token: SELL_TOKENS }),
});

/** Refund outputs of a signed transaction must mirror their inputs and pay the owner. */
const expectRefund = (hex: string, index: number, utxo: Utxo, maxNetworkFee: bigint): void => {
  const output = decode(hex).outputs[index];
  expect(output?.lockingBytecode).toEqual(OWNER.lockingBytecode);
  expect(output?.token?.amount).toBe(utxo.token?.amount);
  expect(output?.token === undefined ? undefined : binToHex(output.token.category)).toBe(
    utxo.token?.category,
  );
  expect((output?.valueSatoshis ?? 0n) >= utxo.satoshis - maxNetworkFee).toBe(true);
};

describe('cancel() authorized by an owner P2PKH input', () => {
  it.each(['buy', 'sell'] as const)('refunds a %s order', async (side) => {
    const chain = new Chain();
    const { order, utxo } = fundedOrders(chain)[side];
    const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
    const tx = buildSignedCancelTransaction({
      owner: { utxos: [ownerUtxo] },
      orders: [{ order, utxo }],
      ownerSigner: OWNER.signer,
    });
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    const decoded = decode(tx.hex);
    expect(decoded.outputs[0]).toEqual({ lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n });
    expectRefund(tx.hex, 1, utxo, order.params.maxNetworkFee);
  });

  it('cancels two orders of one owner in one transaction', async () => {
    const chain = new Chain();
    const { buy, sell } = fundedOrders(chain);
    const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
    const tx = buildSignedCancelTransaction({
      owner: { utxos: [ownerUtxo] },
      orders: [buy, sell],
      ownerSigner: OWNER.signer,
    });
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    expectRefund(tx.hex, 1, buy.utxo, 2000n);
    expectRefund(tx.hex, 2, sell.utxo, 2000n);
  });

  it('refunds a token-less UTXO sent to a sell order address', async () => {
    const chain = new Chain();
    const { sell } = fundedOrders(chain);
    const stray = chain.addUtxoAt(sell.order, { satoshis: 50_000n });
    const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
    const tx = buildSignedCancelTransaction({
      owner: { utxos: [ownerUtxo] },
      orders: [{ order: sell.order, utxo: stray }],
      ownerSigner: OWNER.signer,
    });
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    expect(decode(tx.hex).outputs[1]?.token).toBeUndefined();
  });

  it('refunds a UTXO of another token at an order address, mirroring its tokens', async () => {
    const chain = new Chain();
    const { buy } = fundedOrders(chain);
    const stray = chain.addUtxoAt(buy.order, {
      satoshis: 3000n,
      token: { category: OTHER_CATEGORY, amount: 7n },
    });
    const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
    const tx = buildSignedCancelTransaction({
      owner: { utxos: [ownerUtxo] },
      orders: [{ order: buy.order, utxo: stray }],
      ownerSigner: OWNER.signer,
    });
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    expectRefund(tx.hex, 1, stray, 2000n);
  });

  it('rejects cancel() without the owner input at index 0', () => {
    const chain = new Chain();
    const { buy } = fundedOrders(chain);
    const strangerUtxo = chain.addP2pkh(STRANGER, 1000n);
    expect(() =>
      buildSignedCancelTransaction({
        owner: { utxos: [strangerUtxo] },
        orders: [buy],
        ownerSigner: STRANGER.signer,
      }),
    ).toThrow(TransactionBuildError);
    const builder = new TransactionBuilder({ provider: chain.provider })
      .addInput(strangerUtxo, STRANGER.signer.unlockP2PKH())
      .addInput(buy.utxo, buy.order.contract.unlock.cancel())
      .addOutput({ to: STRANGER.lockingBytecode, amount: 1000n })
      .addOutput({ to: OWNER.lockingBytecode, amount: BUY_VALUE - 1000n });
    const hex = builder.build();
    expectRejected(decode(hex), [sourceOutputOf(strangerUtxo), sourceOutputOf(buy.utxo)], 1);
  });

  it('rejects a refund to a non-owner and a refund that drops tokens', () => {
    const chain = new Chain();
    const { sell } = fundedOrders(chain);
    const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
    const unlockOwner = ownerP2pkhInput(ownerUtxo);
    const inputs = [
      unlockOwner,
      { utxo: sell.utxo, unlock: contractUnlock(sell.order.contract.unlock.cancel()) },
    ];
    const toStranger = rawTransaction(inputs, [
      { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n },
      tokenOutput(STRANGER.lockingBytecode, 1500n, CATEGORY, SELL_TOKENS.amount),
    ]);
    expectRejected(toStranger.transaction, toStranger.sourceOutputs, 1);
    const dropped = rawTransaction(inputs, [
      { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n },
      { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1500n },
    ]);
    expectRejected(dropped.transaction, dropped.sourceOutputs, 1);
  });

  it('rejects swapped refund indices in a batch cancel', () => {
    const chain = new Chain();
    const { buy, sell } = fundedOrders(chain);
    const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
    const { transaction, sourceOutputs } = rawTransaction(
      [
        ownerP2pkhInput(ownerUtxo),
        { utxo: buy.utxo, unlock: contractUnlock(buy.order.contract.unlock.cancel()) },
        { utxo: sell.utxo, unlock: contractUnlock(sell.order.contract.unlock.cancel()) },
      ],
      [
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n },
        tokenOutput(OWNER.lockingBytecode, 1500n, CATEGORY, SELL_TOKENS.amount),
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: BUY_VALUE - 1000n },
      ],
    );
    expectRejected(transaction, sourceOutputs, 1);
  });
});

describe('cancel() of a deposit too small to pay its own fee', () => {
  const STRAY_TOKENS = { category: CATEGORY, amount: 1_000_000n };

  const cancelStray = (chain: Chain, stray: CancelableOrder, ownerSatoshis: bigint) =>
    buildSignedCancelTransaction({
      owner: { utxos: [chain.addP2pkh(OWNER, ownerSatoshis)] },
      orders: [stray],
      ownerSigner: OWNER.signer,
    });

  const expectShortfallFromOwner = async (
    chain: Chain,
    stray: CancelableOrder,
    ownerSatoshis: bigint,
  ): Promise<void> => {
    const tx = cancelStray(chain, stray, ownerSatoshis);
    const { fee } = await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    const [ownerOutput, refund] = decode(tx.hex).outputs;
    if (ownerOutput === undefined || refund === undefined) throw new Error('missing outputs');
    expectRefund(tx.hex, 1, stray.utxo, stray.order.params.maxNetworkFee);
    expect(refund.valueSatoshis).toBe(getDustThreshold(refund));
    expect(fee > stray.utxo.satoshis - refund.valueSatoshis).toBe(true);
    expect(ownerOutput.valueSatoshis).toBe(ownerSatoshis + stray.utxo.satoshis - refund.valueSatoshis - fee);
    expect(ownerOutput.valueSatoshis >= getDustThreshold(ownerOutput)).toBe(true);
  };

  it('refunds an 800-sat stray holding 1,000,000 tokens at a sell address, the owner output covering the rest', async () => {
    const chain = new Chain();
    const { sell } = fundedOrders(chain);
    const stray = chain.addUtxoAt(sell.order, { satoshis: 800n, token: STRAY_TOKENS });
    await expectShortfallFromOwner(chain, { order: sell.order, utxo: stray }, 10_000n);
  });

  it('refunds a 1000-sat token-less stray at a buy address, the owner output covering the rest', async () => {
    const chain = new Chain();
    const { buy } = fundedOrders(chain);
    const stray = chain.addUtxoAt(buy.order, { satoshis: 1000n });
    await expectShortfallFromOwner(chain, { order: buy.order, utxo: stray }, 10_000n);
  });

  it('raises a below-dust stray to the dust threshold so the refund relays', async () => {
    const chain = new Chain();
    const { sell } = fundedOrders(chain);
    const stray = chain.addUtxoAt(sell.order, { satoshis: 600n, token: STRAY_TOKENS });
    const tx = cancelStray(chain, { order: sell.order, utxo: stray }, 10_000n);
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    const refund = decode(tx.hex).outputs[1];
    if (refund === undefined) throw new Error('missing refund');
    expect(refund.valueSatoshis).toBe(getDustThreshold(refund));
    expect(refund.valueSatoshis > 600n).toBe(true);
  });

  it('still takes the fee from the order allowance first, leaving the owner output untouched', async () => {
    const chain = new Chain();
    const { sell } = fundedOrders(chain);
    const stray = chain.addUtxoAt(sell.order, { satoshis: 1400n, token: STRAY_TOKENS });
    const tx = cancelStray(chain, { order: sell.order, utxo: stray }, 10_000n);
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    expect(decode(tx.hex).outputs[0]?.valueSatoshis).toBe(10_000n);
  });

  it('refuses when the owner UTXO cannot cover the shortfall and stay above dust, naming the size to send', async () => {
    const chain = new Chain();
    const { sell } = fundedOrders(chain);
    const stray = chain.addUtxoAt(sell.order, { satoshis: 800n, token: STRAY_TOKENS });
    let required = 0n;
    try {
      cancelStray(chain, { order: sell.order, utxo: stray }, 1000n);
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerUtxoRequiredError);
      expect(error).toMatchObject({ reason: 'owner_utxo_too_small', largestSatoshis: 1000n });
      required = (error as OwnerUtxoRequiredError).requiredSatoshis;
    }
    expect(required > 1000n).toBe(true);
    expect(() => cancelStray(chain, { order: sell.order, utxo: stray }, required - 1n)).toThrow(
      OwnerUtxoRequiredError,
    );
    const tx = cancelStray(chain, { order: sell.order, utxo: stray }, required);
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    const ownerOutput = decode(tx.hex).outputs[0];
    if (ownerOutput === undefined) throw new Error('missing owner output');
    expect(ownerOutput.valueSatoshis).toBe(getDustThreshold(ownerOutput));
  });

  it('never spends an owner token UTXO as the cancel() authorization', async () => {
    const chain = new Chain();
    const { buy } = fundedOrders(chain);
    const payout = chain.addP2pkh(OWNER, 1000n, { category: CATEGORY, amount: 1_855n });
    expect(() =>
      buildSignedCancelTransaction({ owner: { utxos: [payout] }, orders: [buy], ownerSigner: OWNER.signer }),
    ).toThrow(expect.objectContaining({ reason: 'owner_address_empty' }));
    const plain = chain.addP2pkh(OWNER, 1000n);
    const tx = buildSignedCancelTransaction({
      owner: { utxos: [payout, plain] },
      orders: [buy],
      ownerSigner: OWNER.signer,
    });
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    expect(binToHex(decode(tx.hex).inputs[0]?.outpointTransactionHash ?? new Uint8Array())).toBe(plain.txid);
  });

  it('cancelWithSig has no owner output to draw on, so it refuses the same stray', () => {
    const chain = new Chain();
    const { sell } = fundedOrders(chain);
    const stray = chain.addUtxoAt(sell.order, { satoshis: 800n, token: STRAY_TOKENS });
    expect(() =>
      buildSignedCancelWithSigTransaction({
        orders: [{ order: sell.order, utxo: stray }],
        ownerSigner: OWNER.signer,
      }),
    ).toThrow(expect.objectContaining({ reason: 'fee_exceeds_allowance' }));
  });
});

describe('cancel() rejections the covenant enforces (rule R)', () => {
  const cancelInputs = (
    chain: Chain,
    order: CancelableOrder['order'],
    utxo: Utxo & { lockingBytecode: string },
  ) => {
    const ownerUtxo = chain.addP2pkh(OWNER, 1000n);
    return {
      ownerUtxo,
      inputs: [ownerP2pkhInput(ownerUtxo), { utxo, unlock: contractUnlock(order.contract.unlock.cancel()) }],
    };
  };

  it('accepts a cancel() refund of exactly V - maxNetworkFee and rejects one satoshi less', async () => {
    const chain = new Chain();
    const { buy } = fundedOrders(chain);
    const { inputs } = cancelInputs(chain, buy.order, buy.utxo);
    const refund = (valueSatoshis: bigint) =>
      rawTransaction(inputs, [
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n },
        { lockingBytecode: OWNER.lockingBytecode, valueSatoshis },
      ]);
    const below = refund(BUY_VALUE - 2001n);
    expectRejected(below.transaction, below.sourceOutputs, 1);
    const exact = refund(BUY_VALUE - 2000n);
    await chain.expectAccepted(exact.hex, exact.sourceOutputs);
  });

  const nftStray = (chain: Chain, capability: 'none' | 'mutable') => {
    const { sell } = fundedOrders(chain);
    const stray = chain.addUtxoAt(sell.order, {
      satoshis: 3000n,
      token: { category: CATEGORY, amount: 7n, nft: { capability, commitment: 'abcd' } },
    });
    return { order: sell.order, stray, ...cancelInputs(chain, sell.order, stray) };
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
  const OWNER_CHANGE: Output = { lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 1000n };

  it('refunds a mutable NFT at an order address with its commitment intact (control)', async () => {
    const chain = new Chain();
    const { order, stray, ownerUtxo } = nftStray(chain, 'mutable');
    const tx = buildSignedCancelTransaction({
      owner: { utxos: [ownerUtxo] },
      orders: [{ order, utxo: stray }],
      ownerSigner: OWNER.signer,
    });
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    const nft = decode(tx.hex).outputs[1]?.token?.nft;
    expect(nft?.capability).toBe('mutable');
    expect(binToHex(nft?.commitment ?? new Uint8Array())).toBe('abcd');
  });

  it.each<[string, Output]>([
    ['rewrites the mutable NFT commitment', nftRefund('mutable', 'abce')],
    ['empties the mutable NFT commitment', nftRefund('mutable', '')],
    ['downgrades the NFT capability', nftRefund('none', 'abcd')],
    ['drops the NFT entirely', tokenOutput(OWNER.lockingBytecode, 2000n, CATEGORY, 7n)],
  ])('rejects a cancel() refund that %s, at the order input', (_name, refund) => {
    const chain = new Chain();
    const { inputs } = nftStray(chain, 'mutable');
    const { transaction, sourceOutputs } = rawTransaction(inputs, [OWNER_CHANGE, refund]);
    expectRejected(transaction, sourceOutputs, 1);
  });

  it('rejects a refund that drops an immutable NFT commitment (token consensus)', () => {
    const chain = new Chain();
    const { inputs } = nftStray(chain, 'none');
    const { transaction, sourceOutputs } = rawTransaction(inputs, [OWNER_CHANGE, nftRefund('none', '')]);
    const error = expectRejected(transaction, sourceOutputs);
    expect(error).toMatch(TOKEN_CONSENSUS_ERROR);
    expect(error).toContain('creates an immutable token');
  });
});

describe('cancelWithSig()', () => {
  it.each(['buy', 'sell'] as const)('refunds a %s order on the owner signature alone', async (side) => {
    const chain = new Chain();
    const { order, utxo } = fundedOrders(chain)[side];
    const tx = buildSignedCancelWithSigTransaction({ orders: [{ order, utxo }], ownerSigner: OWNER.signer });
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    expect(decode(tx.hex).outputs).toHaveLength(1);
    expectRefund(tx.hex, 0, utxo, order.params.maxNetworkFee);
  });

  it('cancels two orders of one owner in one transaction', async () => {
    const chain = new Chain();
    const { buy, sell } = fundedOrders(chain);
    const tx = buildSignedCancelWithSigTransaction({ orders: [buy, sell], ownerSigner: OWNER.signer });
    await chain.expectAccepted(tx.hex, tx.sourceOutputs);
    expectRefund(tx.hex, 0, buy.utxo, 2000n);
    expectRefund(tx.hex, 1, sell.utxo, 2000n);
  });

  it('accepts a refund of exactly V - maxNetworkFee and rejects one satoshi less', async () => {
    const chain = new Chain();
    const { buy } = fundedOrders(chain);
    const signedRefund = (amount: bigint): string =>
      new TransactionBuilder({ provider: chain.provider })
        .addInput(buy.utxo, buy.order.contract.unlock.cancelWithSig(OWNER.publicKey, OWNER.signer))
        .addOutput({ to: OWNER.lockingBytecode, amount })
        .build();
    const below = signedRefund(BUY_VALUE - 2001n);
    expectRejected(decode(below), [sourceOutputOf(buy.utxo)], 0);
    await chain.expectAccepted(signedRefund(BUY_VALUE - 2000n), [sourceOutputOf(buy.utxo)]);
  });

  it('rejects the wrong key', () => {
    const chain = new Chain();
    const { buy } = fundedOrders(chain);
    expect(() =>
      buildSignedCancelWithSigTransaction({ orders: [buy], ownerSigner: STRANGER.signer }),
    ).toThrow(TransactionBuildError);
    const hex = new TransactionBuilder({ provider: chain.provider })
      .addInput(buy.utxo, buy.order.contract.unlock.cancelWithSig(STRANGER.publicKey, STRANGER.signer))
      .addOutput({ to: OWNER.lockingBytecode, amount: BUY_VALUE - 1000n })
      .build();
    expectRejected(decode(hex), [sourceOutputOf(buy.utxo)], 0);
  });

  it('rejects a valid owner signature taken from a different transaction', () => {
    const chain = new Chain();
    const { buy } = fundedOrders(chain);
    const signed = buildSignedCancelWithSigTransaction({ orders: [buy], ownerSigner: OWNER.signer });
    const original = decode(signed.hex);
    const output = original.outputs[0];
    if (output === undefined) throw new Error('missing refund');
    const replayed = { ...original, outputs: [{ ...output, valueSatoshis: output.valueSatoshis - 1n }] };
    expectRejected(replayed, signed.sourceOutputs, 0);
  });
});
