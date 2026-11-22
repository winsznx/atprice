import {
  binToHex,
  encodeLockingBytecodeP2pkh,
  getDustThreshold,
  hexToBin,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { TransactionBuilder, type PlaceholderP2PKHUnlocker, type Utxo } from 'cashscript';
import { describe, expect, it } from 'vitest';
import {
  assertNoTokenBurn,
  buildCancelTransaction,
  buildCancelWithSigTransaction,
  decodeTransactionHex,
  finalizeWalletSignedTransaction,
  InsufficientFundsError,
  instantiateOrder,
  OwnerUtxoRequiredError,
  TokenBurnRefused,
  toWizardConnectDraft,
  type CancelableOrder,
  type SignedTransaction,
} from '../src/index.js';
import { buyParams, CATEGORY, fakeTxid, OTHER_CATEGORY, OWNER, sellParams } from './support/fixtures.js';
import { CHANGE_KEY, fund, KEYS, provider, walletUtxo } from './support/funding.js';
import { signAsWallet } from './support/wallet.js';

const P2PKH_DUST = getDustThreshold({ lockingBytecode: OWNER.lockingBytecode, valueSatoshis: 0n });
const NFT_IMMUTABLE = { capability: 'none', commitment: 'c0ffee' } as const;

const outpointsOf = (hex: string): string[] =>
  decodeTransactionHex(hex).inputs.map(
    (input) => `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
  );
const outpoint = (utxo: Utxo): string => `${utxo.txid}:${utxo.vout}`;

const signAndFinalize = (draft: Parameters<typeof finalizeWalletSignedTransaction>[0]): SignedTransaction =>
  finalizeWalletSignedTransaction(draft, signAsWallet(draft.request, KEYS));

const outputAsUtxo = (signed: SignedTransaction, vout: number): Utxo => {
  const output = decodeTransactionHex(signed.hex).outputs[vout];
  if (output === undefined) throw new Error(`missing output ${vout}`);
  return {
    txid: signed.txid,
    vout,
    satoshis: output.valueSatoshis,
    ...(output.token && {
      token: { category: binToHex(output.token.category), amount: output.token.amount },
    }),
  };
};

const fundedBuy = (): CancelableOrder => {
  const params = buyParams();
  const signed = signAndFinalize(fund(params, 100_000n, [walletUtxo(OWNER, 'receive', 0, 500_000n)]));
  return { order: instantiateOrder(params, provider), utxo: outputAsUtxo(signed, 0) };
};

/** What a filled buy leaves at the owner address: the 1000-sat payout carrying the bought tokens. */
const buyPayout = (): Utxo => ({
  txid: fakeTxid(0xb0),
  vout: 1,
  satoshis: 1000n,
  token: { category: CATEGORY, amount: 1_855n },
});
const plainOwnerUtxo = (seed: number, satoshis: bigint): Utxo => ({
  txid: fakeTxid(seed),
  vout: 0,
  satoshis,
});

const shortfallOf = (action: () => unknown): OwnerUtxoRequiredError => {
  try {
    action();
  } catch (error) {
    if (error instanceof OwnerUtxoRequiredError) return error;
    throw error;
  }
  throw new Error('expected OwnerUtxoRequiredError');
};

describe('cancel() owner input selection', () => {
  it('treats an owner address holding only a buy payout UTXO as empty and says how much to send', () => {
    const order = fundedBuy();
    const payout = buyPayout();
    const empty = shortfallOf(() => buildCancelTransaction({ owner: { utxos: [payout] }, orders: [order] }));
    expect(empty.reason).toBe('owner_address_empty');
    expect(empty.requiredSatoshis).toBe(P2PKH_DUST);
    expect(empty.largestSatoshis).toBe(0n);
    expect(shortfallOf(() => buildCancelTransaction({ owner: { utxos: [] }, orders: [order] })).reason).toBe(
      'owner_address_empty',
    );

    const topUp = plainOwnerUtxo(0xb1, empty.requiredSatoshis);
    const draft = buildCancelTransaction({ owner: { utxos: [payout, topUp] }, orders: [order] });
    expect(draft.ownerUtxo).toMatchObject(topUp);
    const signed = signAndFinalize(draft);
    expect(outpointsOf(signed.hex)).toEqual([outpoint(topUp), outpoint(order.utxo)]);
    expect(outpointsOf(signed.hex)).not.toContain(outpoint(payout));
    const [ownerOutput] = decodeTransactionHex(signed.hex).outputs;
    expect(ownerOutput).toEqual({ lockingBytecode: OWNER.lockingBytecode, valueSatoshis: P2PKH_DUST });
  });

  it('names the exact single-payment size for a near-dust stray, and builds at exactly that size', () => {
    const { order } = fundedBuy();
    const stray: CancelableOrder = { order, utxo: { txid: fakeTxid(0xb2), vout: 0, satoshis: 700n } };
    const small = plainOwnerUtxo(0xb3, 1000n);
    const tooSmall = shortfallOf(() =>
      buildCancelTransaction({ owner: { utxos: [buyPayout(), small] }, orders: [stray] }),
    );
    expect(tooSmall.reason).toBe('owner_utxo_too_small');
    expect(tooSmall.largestSatoshis).toBe(1000n);
    expect(tooSmall.requiredSatoshis > 1000n).toBe(true);

    const oneShort = plainOwnerUtxo(0xb4, tooSmall.requiredSatoshis - 1n);
    expect(
      shortfallOf(() => buildCancelTransaction({ owner: { utxos: [small, oneShort] }, orders: [stray] }))
        .requiredSatoshis,
    ).toBe(tooSmall.requiredSatoshis);

    const exact = plainOwnerUtxo(0xb5, tooSmall.requiredSatoshis);
    const signed = signAndFinalize(
      buildCancelTransaction({ owner: { utxos: [small, oneShort, exact] }, orders: [stray] }),
    );
    expect(outpointsOf(signed.hex)[0]).toBe(outpoint(exact));
    expect(decodeTransactionHex(signed.hex).outputs[0]?.valueSatoshis).toBe(P2PKH_DUST);
  });

  it('picks the smallest token-free owner UTXO that suffices and never a token UTXO', () => {
    const order = fundedBuy();
    const tokenRich = {
      ...plainOwnerUtxo(0xb6, 5_000_000n),
      token: { category: OTHER_CATEGORY, amount: 9n },
    };
    const nft = {
      ...plainOwnerUtxo(0xb7, 4_000_000n),
      token: { category: CATEGORY, amount: 0n, nft: NFT_IMMUTABLE },
    };
    const large = plainOwnerUtxo(0xb8, 90_000n);
    const marker = plainOwnerUtxo(0xb9, 1000n);
    const draft = buildCancelTransaction({
      owner: { utxos: [tokenRich, nft, large, marker] },
      orders: [order],
    });
    expect(draft.ownerUtxo).toMatchObject(marker);
    const tx = decodeTransactionHex(draft.unsignedHex);
    expect(tx.outputs[0]?.token).toBeUndefined();
    signAndFinalize(draft);
  });
});

describe('token-aware funding', () => {
  it('funds a sell from one token UTXO larger than the order and returns the excess on output 3', () => {
    const params = sellParams();
    const tokenUtxo = walletUtxo(OWNER, 'receive', 0, 800n, { category: CATEGORY, amount: 1_000_000n });
    const bch = walletUtxo(CHANGE_KEY, 'change', 3, 20_000n);
    const draft = fund(params, 250_000n, [tokenUtxo, bch]);
    const signed = signAndFinalize(draft);
    const tx = decodeTransactionHex(signed.hex);
    expect(outpointsOf(signed.hex)).toEqual([outpoint(tokenUtxo), outpoint(bch)]);
    expect(tx.outputs).toHaveLength(4);
    expect(tx.outputs[0]?.token?.amount).toBe(250_000n);
    expect(tx.outputs[2]?.token).toBeUndefined();
    expect(tx.outputs[2]?.lockingBytecode).toEqual(OWNER.lockingBytecode);
    const change = tx.outputs[3];
    expect(change?.lockingBytecode).toEqual(OWNER.lockingBytecode);
    expect(change?.token && binToHex(change.token.category)).toBe(CATEGORY);
    expect(change?.token?.amount).toBe(750_000n);
    expect(change?.token?.nft).toBeUndefined();
    expect(change && change.valueSatoshis).toBe(change && getDustThreshold(change));
    expect(draft.ownerTokenChange).toBe(750_000n);
    expect(draft.ownerOutputSatoshis).toBe(20_800n - 2000n - (change?.valueSatoshis ?? 0n) - signed.fee);
    expect(() => assertNoTokenBurn(tx, signed.sourceOutputs)).not.toThrow();
  });

  it('adds no output 3 when the token inputs equal the order amount', () => {
    const draft = fund(sellParams(), 1000n, [
      walletUtxo(OWNER, 'receive', 0, 800n, { category: CATEGORY, amount: 1000n }),
      walletUtxo(OWNER, 'receive', 0, 10_000n),
    ]);
    expect(decodeTransactionHex(draft.unsignedHex).outputs).toHaveLength(3);
    expect(draft.ownerTokenChange).toBe(0n);
  });

  it('funds a buy from a wallet that also holds token UTXOs without spending any of them', () => {
    const tokenUtxos = [
      walletUtxo(OWNER, 'receive', 0, 9_000_000n, { category: CATEGORY, amount: 50n }),
      walletUtxo(OWNER, 'receive', 0, 8_000_000n, { category: OTHER_CATEGORY, amount: 7n }),
      walletUtxo(CHANGE_KEY, 'change', 3, 7_000_000n, { category: CATEGORY, amount: 0n, nft: NFT_IMMUTABLE }),
    ];
    const larger = walletUtxo(OWNER, 'receive', 0, 80_000n);
    const plain = [larger, walletUtxo(CHANGE_KEY, 'change', 3, 60_000n)];
    const draft = fund(buyParams(), 100_000n, [...tokenUtxos, ...plain]);
    const signed = signAndFinalize(draft);
    expect(outpointsOf(signed.hex)).toEqual(plain.map(outpoint));
    expect(decodeTransactionHex(signed.hex).outputs.every((output) => output.token === undefined)).toBe(true);

    expect(() => fund(buyParams(), 100_000n, [...tokenUtxos, larger])).toThrow(InsufficientFundsError);
  });

  it('never selects an NFT, for a buy or for a sell of the NFT category', () => {
    const nftOnly = walletUtxo(OWNER, 'receive', 0, 5_000_000n, {
      category: CATEGORY,
      amount: 0n,
      nft: NFT_IMMUTABLE,
    });
    const nftWithTokens = walletUtxo(OWNER, 'receive', 0, 5_000_000n, {
      category: CATEGORY,
      amount: 1_000_000n,
      nft: { capability: 'mutable', commitment: '01' },
    });
    const plainTokens = walletUtxo(OWNER, 'receive', 0, 800n, { category: CATEGORY, amount: 400n });
    const bch = walletUtxo(CHANGE_KEY, 'change', 3, 30_000n);
    const nftOutpoints = [outpoint(nftOnly), outpoint(nftWithTokens)];

    const sell = signAndFinalize(fund(sellParams(), 400n, [nftOnly, nftWithTokens, plainTokens, bch]));
    expect(outpointsOf(sell.hex).some((spent) => nftOutpoints.includes(spent))).toBe(false);
    const buy = signAndFinalize(fund(buyParams(), 10_000n, [nftOnly, nftWithTokens, bch]));
    expect(outpointsOf(buy.hex)).toEqual([outpoint(bch)]);

    const shortfall = (() => {
      try {
        fund(sellParams(), 401n, [nftOnly, nftWithTokens, plainTokens, bch]);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(shortfall).toBeInstanceOf(InsufficientFundsError);
    expect(shortfall).toMatchObject({ reason: 'insufficient_tokens', required: 401n, available: 400n });
  });
});

describe('zero-burn check', () => {
  const signedSellFunding = () =>
    signAndFinalize(
      fund(sellParams(), 250_000n, [
        walletUtxo(OWNER, 'receive', 0, 800n, { category: CATEGORY, amount: 1_000_000n }),
        walletUtxo(CHANGE_KEY, 'change', 3, 20_000n),
      ]),
    );
  const reasonOf = (transaction: Pick<TransactionCommon, 'outputs'>, sourceOutputs: readonly Output[]) => {
    try {
      assertNoTokenBurn(transaction, sourceOutputs);
    } catch (error) {
      if (error instanceof TokenBurnRefused) return `${error.reason}:${error.category}`;
      throw error;
    }
    return 'conserved';
  };

  it('refuses a hand-built transaction that drops the token change output', () => {
    const signed = signedSellFunding();
    const tx = decodeTransactionHex(signed.hex);
    expect(reasonOf(tx, signed.sourceOutputs)).toBe('conserved');
    expect(reasonOf({ outputs: tx.outputs.slice(0, 3) }, signed.sourceOutputs)).toBe(
      `fungible_mismatch:${CATEGORY}`,
    );
  });

  it('refuses one fungible unit lost or gained, and an NFT dropped or altered', () => {
    const nftSource: Output = {
      lockingBytecode: OWNER.lockingBytecode,
      valueSatoshis: 5000n,
      token: {
        category: hexToBin(CATEGORY),
        amount: 10n,
        nft: { capability: 'mutable', commitment: hexToBin('ab') },
      },
    };
    const keep = (amount: bigint, nft?: { capability: 'none' | 'mutable'; commitment: string }): Output => ({
      lockingBytecode: OWNER.lockingBytecode,
      valueSatoshis: 4000n,
      token: {
        category: hexToBin(CATEGORY),
        amount,
        ...(nft && { nft: { capability: nft.capability, commitment: hexToBin(nft.commitment) } }),
      },
    });
    const sources = [nftSource];
    expect(reasonOf({ outputs: [keep(10n, { capability: 'mutable', commitment: 'ab' })] }, sources)).toBe(
      'conserved',
    );
    expect(reasonOf({ outputs: [keep(9n, { capability: 'mutable', commitment: 'ab' })] }, sources)).toBe(
      `fungible_mismatch:${CATEGORY}`,
    );
    expect(reasonOf({ outputs: [keep(11n, { capability: 'mutable', commitment: 'ab' })] }, sources)).toBe(
      `fungible_mismatch:${CATEGORY}`,
    );
    expect(reasonOf({ outputs: [keep(10n)] }, sources)).toBe(`nft_mismatch:${CATEGORY}`);
    expect(reasonOf({ outputs: [keep(10n, { capability: 'none', commitment: 'ab' })] }, sources)).toBe(
      `nft_mismatch:${CATEGORY}`,
    );
    expect(reasonOf({ outputs: [keep(10n, { capability: 'mutable', commitment: 'ac' })] }, sources)).toBe(
      `nft_mismatch:${CATEGORY}`,
    );
  });

  it('stops a burning builder before any sign request is produced, NFT burns included', () => {
    const ownerHex = binToHex(OWNER.lockingBytecode);
    const unlocker: PlaceholderP2PKHUnlocker = {
      generateUnlockingBytecode: () => new Uint8Array(),
      placeholder: true,
      lockingBytecode: ownerHex,
    };
    const nftInput = {
      lockingBytecode: ownerHex,
      txid: fakeTxid(0xe1),
      vout: 0,
      satoshis: 10_000n,
      token: { category: CATEGORY, amount: 0n, nft: NFT_IMMUTABLE },
    };
    const builder = new TransactionBuilder({ provider })
      .addInput(nftInput, unlocker)
      .addOutput({ to: encodeLockingBytecodeP2pkh(OWNER.pkh), amount: 9000n });
    expect(() =>
      toWizardConnectDraft(builder, { inputPaths: [[0, 'receive', 0]], contractInputs: [], userPrompt: 'x' }),
    ).toThrow(TokenBurnRefused);
  });

  it('passes every cancel draft, which mirrors each order token on its refund', () => {
    const params = sellParams();
    const signed = signedSellFunding();
    const order: CancelableOrder = {
      order: instantiateOrder(params, provider),
      utxo: outputAsUtxo(signed, 0),
    };
    const draft = buildCancelTransaction({
      owner: { utxos: [outputAsUtxo(signed, 2), outputAsUtxo(signed, 3)] },
      orders: [order],
    });
    expect(draft.ownerUtxo.vout).toBe(2);
    expect(() =>
      assertNoTokenBurn(decodeTransactionHex(draft.unsignedHex), draft.sourceOutputs),
    ).not.toThrow();
    const withSig = buildCancelWithSigTransaction({ orders: [order] });
    expect(() =>
      assertNoTokenBurn(decodeTransactionHex(withSig.unsignedHex), withSig.sourceOutputs),
    ).not.toThrow();
  });
});
