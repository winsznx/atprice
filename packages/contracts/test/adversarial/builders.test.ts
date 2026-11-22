import { binToHex, encodeTransactionBch, type Output, type TransactionCommon } from '@bitauth/libauth';
import type { Utxo } from 'cashscript';
import { describe, expect, it } from 'vitest';
import {
  AtPriceError,
  buildCancelTransaction,
  buildCancelWithSigTransaction,
  buildFundingTransaction,
  buildSignedCancelTransaction,
  buildSignedCancelWithSigTransaction,
  bytesEqual,
  decodeTransactionHex,
  finalizeWalletSignedTransaction,
  instantiateOrder,
  type CancelableOrder,
  type FundingDraft,
  type OrderParams,
  type SignedTransaction,
  type UnsignedTransactionDraft,
  type WalletPathName,
  type WalletUtxo,
} from '@atprice/core';
import {
  CATEGORY,
  Chain,
  decode,
  key,
  OTHER_CATEGORY,
  orderParams,
  OWNER,
  sourceOutputOf,
  type Key,
} from '../harness.js';
import { p2pkhUnlock, SIGHASH_ALL_UTXOS, verifyAll } from './support.js';

type Token = NonNullable<Utxo['token']>;
type Capability = NonNullable<Token['nft']>['capability'];

const THIRD_CATEGORY = 'aa'.repeat(31) + '03';
/** Holds the consensus-maximum fungible supply, so no other UTXO may carry this category. */
const MAX_SUPPLY_CATEGORY = 'bb'.repeat(31) + '04';
const MAX_FT = 9_223_372_036_854_775_807n;
const CHANGE_KEY = key(0x31);
const RECEIVE_5 = key(0x32);
const WALLET_KEYS: readonly Key[] = [OWNER, CHANGE_KEY, RECEIVE_5];
const BUY_VALUE = 10_003_000n;
const COMMITMENT_40 = 'c4'.repeat(40);

const ft = (category: string, amount: bigint): Token => ({ category, amount });
const nft = (category: string, capability: Capability, commitment: string, amount = 0n): Token => ({
  category,
  amount,
  nft: { capability, commitment },
});

const PATHS = new Map<Key, readonly [WalletPathName, number]>([
  [OWNER, ['receive', 0]],
  [CHANGE_KEY, ['change', 3]],
  [RECEIVE_5, ['receive', 5]],
]);

const walletUtxo = (chain: Chain, holder: Key, satoshis: bigint, token?: Token): WalletUtxo => {
  const [pathName, addressIndex] = PATHS.get(holder) ?? ['receive', 0];
  return { ...chain.addP2pkh(holder, satoshis, token), ...(token && { token }), pathName, addressIndex };
};

const fund = (chain: Chain, side: OrderParams['side'], amount: bigint, walletUtxos: readonly WalletUtxo[]) =>
  buildFundingTransaction({
    params: orderParams(side),
    amount,
    minimumAmount: 1n,
    walletUtxos,
    network: 'chipnet',
    provider: chain.provider,
  });

/** Signs every input the request lists in `inputPaths` the way an honest wallet does (ALL|UTXOS). */
const signAsWallet = (draft: UnsignedTransactionDraft, keys: readonly Key[] = WALLET_KEYS): string => {
  const transaction: TransactionCommon = decodeTransactionHex(draft.unsignedHex);
  const sourceOutputs = [...draft.sourceOutputs];
  for (const [inputIndex] of draft.request.inputPaths) {
    const locking = sourceOutputs[inputIndex]?.lockingBytecode ?? new Uint8Array();
    const signer = keys.find((candidate) => bytesEqual(candidate.lockingBytecode, locking));
    const input = transaction.inputs[inputIndex];
    if (signer === undefined || input === undefined) throw new Error(`no key for input ${inputIndex}`);
    const unlock = p2pkhUnlock(signer, SIGHASH_ALL_UTXOS);
    input.unlockingBytecode =
      typeof unlock === 'function' ? unlock(transaction, sourceOutputs, inputIndex) : unlock;
  }
  return binToHex(encodeTransactionBch(transaction));
};

const signAndFinalize = (draft: UnsignedTransactionDraft): SignedTransaction =>
  finalizeWalletSignedTransaction(draft, signAsWallet(draft));

/** The stable `reason` of an AtPrice error, `accepted` when nothing was thrown, or `other:<name>`. */
const outcome = (run: () => unknown): string => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return error instanceof AtPriceError ? error.reason : `other:${(error as Error).name}`;
  }
};

/** The UTXO as a token-unaware (or lying) feed reports it: same outpoint and sats, token dropped. */
const withoutToken = <T extends Utxo>(utxo: T): Omit<T, 'token'> => {
  const copy: Partial<T> = { ...utxo };
  delete copy.token;
  return copy as Omit<T, 'token'>;
};

const outpoint = (utxo: Pick<Utxo, 'txid' | 'vout'>): string => `${utxo.txid}:${utxo.vout}`;
const spentOutpoints = (hex: string): string[] =>
  decodeTransactionHex(hex).inputs.map(
    (input) => `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
  );

/** Independent of core's tally: per category, fungible total and the sorted multiset of NFTs. */
const ledger = (outputs: readonly Output[]): Record<string, { ft: bigint; nfts: string[] }> => {
  const byCategory: Record<string, { ft: bigint; nfts: string[] }> = {};
  for (const { token } of outputs) {
    if (token === undefined) continue;
    const category = binToHex(token.category);
    const entry = (byCategory[category] ??= { ft: 0n, nfts: [] });
    entry.ft += token.amount;
    if (token.nft) entry.nfts.push(`${token.nft.capability}:${binToHex(token.nft.commitment)}`);
  }
  for (const entry of Object.values(byCategory)) entry.nfts.sort();
  return byCategory;
};

const tokenKey = (output: Output | undefined): string =>
  output?.token === undefined
    ? 'none'
    : `${binToHex(output.token.category)}|${output.token.amount}|${
        output.token.nft ? `${output.token.nft.capability}:${binToHex(output.token.nft.commitment)}` : '-'
      }`;

/**
 * The two properties under attack: no token is created or destroyed, and every token output lands
 * at the owner address except the ones named in `leaving` (the sell order output).
 */
const expectNoBurnNoMisdirection = (
  transaction: TransactionCommon,
  sourceOutputs: readonly Output[],
  leaving: ReadonlyMap<number, { lockingBytecode: Uint8Array; token: string }> = new Map(),
): void => {
  expect(ledger(transaction.outputs)).toEqual(ledger(sourceOutputs));
  transaction.outputs.forEach((output, index) => {
    if (output.token === undefined) return;
    const allowed = leaving.get(index);
    if (allowed === undefined) {
      expect(binToHex(output.lockingBytecode), `token output ${index} leaves the owner`).toBe(
        binToHex(OWNER.lockingBytecode),
      );
    } else {
      expect(binToHex(output.lockingBytecode)).toBe(binToHex(allowed.lockingBytecode));
      expect(tokenKey(output)).toBe(allowed.token);
    }
  });
};

const sellOrderOutput = (draft: FundingDraft, amount: bigint) =>
  new Map([[0, { lockingBytecode: draft.orderLockingBytecode, token: `${CATEGORY}|${amount}|-` }]]);

/**
 * A wallet that holds a bit of everything: plain fungible tokens of the market and of two other
 * categories, NFTs of every capability (with and without fungible amounts, empty and 40-byte
 * commitments), token UTXOs worth far more sats than the plain ones, and consensus-valid token
 * UTXOs below the dust limit. The plain BCH is spread over three addresses.
 */
const kitchenSink = (chain: Chain) => {
  const tokens = {
    marketFt: [
      walletUtxo(chain, OWNER, 800n, ft(CATEGORY, 400n)),
      walletUtxo(chain, CHANGE_KEY, 1_000n, ft(CATEGORY, 300n)),
      walletUtxo(chain, RECEIVE_5, 1n, ft(CATEGORY, 200n)),
      walletUtxo(chain, OWNER, 800n, ft(CATEGORY, 1n)),
    ],
    marketNft: [
      walletUtxo(chain, OWNER, 9_000_000n, nft(CATEGORY, 'minting', '')),
      walletUtxo(chain, OWNER, 8_000_000n, nft(CATEGORY, 'mutable', COMMITMENT_40, 5_000_000n)),
      walletUtxo(chain, CHANGE_KEY, 7_000_000n, nft(CATEGORY, 'none', 'c0ffee', 9_000_000n)),
      walletUtxo(chain, RECEIVE_5, 1n, nft(CATEGORY, 'none', '01')),
    ],
    other: [
      walletUtxo(chain, OWNER, 50_000_000n, ft(MAX_SUPPLY_CATEGORY, MAX_FT)),
      walletUtxo(chain, CHANGE_KEY, 6_000_000n, nft(OTHER_CATEGORY, 'minting', 'ff', 12n)),
      walletUtxo(chain, OWNER, 2n, nft(THIRD_CATEGORY, 'mutable', '')),
      walletUtxo(chain, RECEIVE_5, 700n, ft(THIRD_CATEGORY, 3n)),
    ],
  };
  const plain = [
    walletUtxo(chain, OWNER, 40_000n),
    walletUtxo(chain, CHANGE_KEY, 30_000n),
    walletUtxo(chain, RECEIVE_5, 25_000n),
  ];
  const all = [...tokens.marketNft, ...tokens.other, ...tokens.marketFt, ...plain];
  return { ...tokens, plain, all };
};

describe('adversarial funding: crafted wallet UTXO sets', () => {
  it('buy from the kitchen-sink wallet spends only token-free UTXOs and creates no token output', async () => {
    const chain = new Chain();
    const wallet = kitchenSink(chain);
    const signed = signAndFinalize(fund(chain, 'buy', 60_000n, wallet.all));
    const tx = decode(signed.hex);
    const plainOutpoints = wallet.plain.map(outpoint);
    expect(spentOutpoints(signed.hex).every((spent) => plainOutpoints.includes(spent))).toBe(true);
    expect(tx.outputs.every((output) => output.token === undefined)).toBe(true);
    expectNoBurnNoMisdirection(tx, signed.sourceOutputs);
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('buy refuses when only token UTXOs could pay, even though they hold 0.8 BCH', () => {
    const chain = new Chain();
    const wallet = kitchenSink(chain);
    const tokenOnly = [...wallet.marketNft, ...wallet.other, ...wallet.marketFt];
    expect(outcome(() => fund(chain, 'buy', 10_000n, tokenOnly))).toBe('insufficient_bch');
    expect(outcome(() => fund(chain, 'buy', 100_000n, wallet.all))).toBe('insufficient_bch');
  });

  it('sell spread over several token UTXOs spends only plain market FTs, sends exactly the amount, returns the rest on output 3', async () => {
    const chain = new Chain();
    const wallet = kitchenSink(chain);
    const draft = fund(chain, 'sell', 650n, wallet.all);
    const signed = signAndFinalize(draft);
    const tx = decode(signed.hex);
    const allowed = new Set([...wallet.marketFt, ...wallet.plain].map(outpoint));
    const spent = spentOutpoints(signed.hex);
    expect(spent.every((entry) => allowed.has(entry))).toBe(true);
    // #then largest first: 400 + 300 covers 650; the 200 and 1-unit UTXOs stay put
    expect(spent.slice(0, 2)).toEqual(wallet.marketFt.slice(0, 2).map(outpoint));
    for (const untouched of wallet.marketFt.slice(2)) expect(spent).not.toContain(outpoint(untouched));
    expect(tx.outputs).toHaveLength(4);
    expect(tokenKey(tx.outputs[3])).toBe(`${CATEGORY}|50|-`);
    expect(tx.outputs[2]?.token).toBeUndefined();
    expectNoBurnNoMisdirection(tx, signed.sourceOutputs, sellOrderOutput(draft, 650n));
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('sell of every plain market FT unit (901) spends all four, adds no output 3, and 902 refuses without touching the 14M units on NFT UTXOs', async () => {
    const chain = new Chain();
    const wallet = kitchenSink(chain);
    const draft = fund(chain, 'sell', 901n, wallet.all);
    const signed = signAndFinalize(draft);
    const tx = decode(signed.hex);
    expect(tx.outputs).toHaveLength(3);
    for (const utxo of wallet.marketFt) expect(spentOutpoints(signed.hex)).toContain(outpoint(utxo));
    expectNoBurnNoMisdirection(tx, signed.sourceOutputs, sellOrderOutput(draft, 901n));
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);

    const fresh = new Chain();
    expect(outcome(() => fund(fresh, 'sell', 902n, kitchenSink(fresh).all))).toBe('insufficient_tokens');
  });

  it('sell funded only by token UTXOs on non-owner paths returns token change to the owner address, not to where it came from', async () => {
    const chain = new Chain();
    const tokenUtxo = walletUtxo(chain, CHANGE_KEY, 1_000n, ft(CATEGORY, 1_000_000n));
    const bch = walletUtxo(chain, RECEIVE_5, 20_000n);
    const draft = fund(chain, 'sell', 999_999n, [tokenUtxo, bch]);
    const signed = signAndFinalize(draft);
    const tx = decode(signed.hex);
    expect(tokenKey(tx.outputs[3])).toBe(`${CATEGORY}|1|-`);
    expect(binToHex(tx.outputs[3]?.lockingBytecode ?? new Uint8Array())).toBe(
      binToHex(OWNER.lockingBytecode),
    );
    expectNoBurnNoMisdirection(tx, signed.sourceOutputs, sellOrderOutput(draft, 999_999n));
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('sell from a single fat token UTXO (no plain BCH) pays the order and the dust from that UTXO without a second input', async () => {
    const chain = new Chain();
    const fat = walletUtxo(chain, OWNER, 5_000_000n, ft(CATEGORY, 10n));
    const draft = fund(chain, 'sell', 3n, [fat, ...kitchenSink(chain).marketNft]);
    const signed = signAndFinalize(draft);
    expect(spentOutpoints(signed.hex)).toEqual([outpoint(fat)]);
    expectNoBurnNoMisdirection(decode(signed.hex), signed.sourceOutputs, sellOrderOutput(draft, 3n));
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('sell from only sub-dust token UTXOs and no plain BCH refuses with insufficient_bch rather than burning to pay the fee', () => {
    const chain = new Chain();
    const dust = [
      walletUtxo(chain, OWNER, 1n, ft(CATEGORY, 5n)),
      walletUtxo(chain, OWNER, 1n, ft(CATEGORY, 5n)),
    ];
    expect(outcome(() => fund(chain, 'sell', 7n, dust))).toBe('insufficient_bch');
  });

  it('dust-sized token change (1 unit) still gets its own output at the token dust threshold, never folded or dropped', async () => {
    const chain = new Chain();
    const tokens = [
      walletUtxo(chain, OWNER, 1n, ft(CATEGORY, 4n)),
      walletUtxo(chain, OWNER, 1n, ft(CATEGORY, 2n)),
    ];
    const bch = walletUtxo(chain, OWNER, 10_000n);
    const draft = fund(chain, 'sell', 5n, [...tokens, bch]);
    const signed = signAndFinalize(draft);
    const tx = decode(signed.hex);
    expect(tokenKey(tx.outputs[3])).toBe(`${CATEGORY}|1|-`);
    expectNoBurnNoMisdirection(tx, signed.sourceOutputs, sellOrderOutput(draft, 5n));
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('a market token reported with an upper-case category id is never spent: sell refuses, buy leaves it alone', () => {
    const chain = new Chain();
    const shouted = walletUtxo(chain, OWNER, 800n, ft(CATEGORY.toUpperCase(), 1_000n));
    const bch = walletUtxo(chain, OWNER, 50_000n);
    expect(outcome(() => fund(chain, 'sell', 10n, [shouted, bch]))).toBe('insufficient_tokens');
    const buy = fund(chain, 'buy', 10_000n, [shouted, bch]);
    expect(spentOutpoints(buy.unsignedHex)).toEqual([outpoint(bch)]);
  });

  it('documents: a `token: null` from a JSON wallet feed is never spent by a buy, but crashes sell selection with a TypeError (no draft, no burn)', () => {
    const chain = new Chain();
    const nulled = { ...walletUtxo(chain, OWNER, 900_000n), token: null } as unknown as WalletUtxo;
    const bch = walletUtxo(chain, OWNER, 50_000n);
    const buy = fund(chain, 'buy', 10_000n, [nulled, bch]);
    expect(spentOutpoints(buy.unsignedHex)).toEqual([outpoint(bch)]);
    expect(outcome(() => fund(chain, 'sell', 10n, [nulled, bch]))).toBe('other:TypeError');
  });

  it('documents: the same token UTXO listed twice (two wallet paths report it) yields a draft that double-counts it; the network rejects it, so nothing burns', async () => {
    const chain = new Chain();
    const tokenUtxo = walletUtxo(chain, OWNER, 800n, ft(CATEGORY, 300n));
    const bch = walletUtxo(chain, OWNER, 50_000n);
    const draft = fund(chain, 'sell', 500n, [tokenUtxo, tokenUtxo, bch]);
    expect(spentOutpoints(draft.unsignedHex).filter((spent) => spent === outpoint(tokenUtxo))).toHaveLength(
      2,
    );
    expect(outcome(() => signAndFinalize(draft))).not.toBe('accepted');
    await expect(chain.provider.sendRawTransaction(signAsWallet(draft))).rejects.toThrow();
  });

  it('a token UTXO reported without its token (lying or token-unaware feed) is spent as plain BCH, and the network rejects the signature, so the token cannot be burned', async () => {
    const chain = new Chain();
    const real = walletUtxo(chain, OWNER, 900_000n, nft(CATEGORY, 'minting', ''));
    const lie = withoutToken(real);
    const draft = fund(chain, 'buy', 10_000n, [lie]);
    expect(spentOutpoints(draft.unsignedHex)).toEqual([outpoint(real)]);
    const hex = signAsWallet(draft);
    const truth = [sourceOutputOf(real)];
    expect(verifyAll(decode(hex), truth)).not.toBe(true);
    await expect(chain.provider.sendRawTransaction(hex)).rejects.toThrow();
  });
});

describe('adversarial finalize: a wallet that tampers with funding token outputs', () => {
  const setup = () => {
    const chain = new Chain();
    const draft = fund(chain, 'sell', 100n, [
      walletUtxo(chain, OWNER, 800n, ft(CATEGORY, 1_000n)),
      walletUtxo(chain, OWNER, 30_000n),
    ]);
    return { draft, tx: decodeTransactionHex(draft.unsignedHex) };
  };
  const signRaw = (draft: FundingDraft, tx: TransactionCommon): string =>
    signAsWallet({ ...draft, unsignedHex: binToHex(encodeTransactionBch(tx)) });

  it('refuses a wallet that drops the token change output 3', () => {
    const { draft, tx } = setup();
    tx.outputs.pop();
    expect(outcome(() => finalizeWalletSignedTransaction(draft, signRaw(draft, tx)))).toBe(
      'wallet_changed_transaction',
    );
  });

  it('refuses a wallet that redirects the token change output 3 to itself', () => {
    const { draft, tx } = setup();
    const change = tx.outputs[3];
    if (change === undefined) throw new Error('no output 3');
    tx.outputs[3] = { ...change, lockingBytecode: key(0x66).lockingBytecode };
    expect(outcome(() => finalizeWalletSignedTransaction(draft, signRaw(draft, tx)))).toBe(
      'wallet_changed_transaction',
    );
  });

  it('refuses a wallet that moves token change units onto the order output', () => {
    const { draft, tx } = setup();
    const [order, , , change] = tx.outputs;
    if (order?.token === undefined || change?.token === undefined) throw new Error('missing token outputs');
    tx.outputs[0] = { ...order, token: { ...order.token, amount: order.token.amount + 1n } };
    tx.outputs[3] = { ...change, token: { ...change.token, amount: change.token.amount - 1n } };
    expect(outcome(() => finalizeWalletSignedTransaction(draft, signRaw(draft, tx)))).toBe(
      'wallet_changed_transaction',
    );
  });
});

describe('adversarial cancel(): owner address contents', () => {
  const ownerTokenOnly = (chain: Chain): Utxo[] => [
    chain.addP2pkh(OWNER, 1_000n, ft(CATEGORY, 1_855n)),
    chain.addP2pkh(OWNER, 90_000_000n, nft(CATEGORY, 'minting', '')),
    chain.addP2pkh(OWNER, 80_000_000n, nft(OTHER_CATEGORY, 'mutable', COMMITMENT_40, 7n)),
    chain.addP2pkh(OWNER, 70_000_000n, nft(THIRD_CATEGORY, 'none', 'ab')),
    chain.addP2pkh(OWNER, 1n, ft(OTHER_CATEGORY, 1n)),
  ];

  it('an owner address holding only token UTXOs (every kind, 2.4 BCH on them) counts as empty, signed and unsigned', () => {
    const chain = new Chain();
    const { order, utxo } = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    const owner = { utxos: ownerTokenOnly(chain) };
    const orders = [{ order, utxo }];
    expect(outcome(() => buildCancelTransaction({ owner, orders }))).toBe('owner_address_empty');
    expect(outcome(() => buildSignedCancelTransaction({ owner, orders, ownerSigner: OWNER.signer }))).toBe(
      'owner_address_empty',
    );
  });

  it('with a sub-dust stray needing a top-up, a too-small plain UTXO is reported as the largest; token UTXOs never count', () => {
    const chain = new Chain();
    const { order } = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    const stray = chain.addUtxoAt(order, { satoshis: 1n, token: nft(CATEGORY, 'none', COMMITMENT_40) });
    const small = chain.addP2pkh(OWNER, 600n);
    const error = (() => {
      try {
        buildCancelTransaction({
          owner: { utxos: [...ownerTokenOnly(chain), small] },
          orders: [{ order, utxo: stray }],
        });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toMatchObject({ reason: 'owner_utxo_too_small', largestSatoshis: 600n });
  });

  it('input 0 is the plain UTXO even when listed after the token UTXOs, and the wallet-signed cancel is accepted', async () => {
    const chain = new Chain();
    const { order, utxo } = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    const plain = chain.addP2pkh(OWNER, 1_000n);
    const draft = buildCancelTransaction({
      owner: { utxos: [...ownerTokenOnly(chain), plain] },
      orders: [{ order, utxo }],
    });
    expect(spentOutpoints(draft.unsignedHex)).toEqual([outpoint(plain), outpoint(utxo)]);
    const signed = signAndFinalize(draft);
    expectNoBurnNoMisdirection(decode(signed.hex), signed.sourceOutputs);
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('an owner token UTXO reported without its token is picked as input 0, and the network rejects the signature, so it cannot be burned', async () => {
    const chain = new Chain();
    const { order, utxo } = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    const real = chain.addP2pkh(OWNER, 5_000n, nft(CATEGORY, 'minting', ''));
    const lie = withoutToken(real);
    const draft = buildCancelTransaction({ owner: { utxos: [lie] }, orders: [{ order, utxo }] });
    expect(spentOutpoints(draft.unsignedHex)[0]).toBe(outpoint(real));
    const hex = signAsWallet(draft);
    expect(verifyAll(decode(hex), [sourceOutputOf(real), sourceOutputOf(utxo)])).not.toBe(true);
    await expect(chain.provider.sendRawTransaction(hex)).rejects.toThrow();
  });
});

describe('adversarial cancel batches with stray deposits', () => {
  /** One owner's buy and sell orders, each address also holding strays of every token shape. */
  const batch = (chain: Chain, options: { subDust: boolean }) => {
    const sell = chain.addOrder(orderParams('sell'), { satoshis: 2000n, token: ft(CATEGORY, 5_000n) });
    const buy = chain.addOrder(orderParams('buy', { nonce: Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9) }), {
      satoshis: BUY_VALUE,
    });
    const sellStrays = [
      chain.addUtxoAt(sell.order, { satoshis: 20_000n, token: ft(OTHER_CATEGORY, 42n) }),
      chain.addUtxoAt(sell.order, { satoshis: 20_000n, token: nft(CATEGORY, 'mutable', COMMITMENT_40, 77n) }),
    ];
    const buyStrays = [
      chain.addUtxoAt(buy.order, { satoshis: 20_000n, token: nft(CATEGORY, 'minting', '') }),
      chain.addUtxoAt(buy.order, { satoshis: 20_000n, token: nft(THIRD_CATEGORY, 'none', 'beef') }),
      chain.addUtxoAt(buy.order, { satoshis: 20_000n, token: ft(MAX_SUPPLY_CATEGORY, MAX_FT) }),
      chain.addUtxoAt(buy.order, { satoshis: 20_000n }),
    ];
    const orders: CancelableOrder[] = [
      sell,
      buy,
      ...sellStrays.map((utxo) => ({ order: sell.order, utxo })),
      ...buyStrays.map((utxo) => ({ order: buy.order, utxo })),
    ];
    if (options.subDust) {
      const subDust = chain.addUtxoAt(sell.order, { satoshis: 1n, token: nft(CATEGORY, 'none', '00') });
      orders.push({ order: sell.order, utxo: subDust });
    }
    return orders;
  };

  /** Refund `k` sits at output `k + offset` and mirrors its input exactly (category, amount, NFT). */
  const expectMirrored = (tx: TransactionCommon, orders: readonly CancelableOrder[], offset: number) => {
    orders.forEach(({ utxo }, index) => {
      const refund = tx.outputs[index + offset];
      expect(binToHex(refund?.lockingBytecode ?? new Uint8Array())).toBe(binToHex(OWNER.lockingBytecode));
      const source = sourceOutputOf({ ...utxo, lockingBytecode: '51' });
      expect(tokenKey(refund), `refund ${index}`).toBe(tokenKey(source));
    });
    expect(tx.outputs).toHaveLength(orders.length + offset);
  };

  it('cancel() refunds every order and every stray (FT, NFTs of all capabilities, max-amount FT, sub-dust NFT) to the owner with its exact token', async () => {
    const chain = new Chain();
    const orders = batch(chain, { subDust: true });
    const owner = chain.addP2pkh(OWNER, 50_000n);
    const draft = buildCancelTransaction({
      owner: { utxos: [chain.addP2pkh(OWNER, 3_000n, ft(CATEGORY, 1n)), owner] },
      orders,
    });
    const signed = signAndFinalize(draft);
    const tx = decode(signed.hex);
    expect(tx.outputs[0]?.token).toBeUndefined();
    expectMirrored(tx, orders, 1);
    expectNoBurnNoMisdirection(tx, signed.sourceOutputs);
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('buildSignedCancelTransaction on the same batch is accepted with the same mirroring', async () => {
    const chain = new Chain();
    const orders = batch(chain, { subDust: true });
    const signed = buildSignedCancelTransaction({
      orders,
      owner: { utxos: [chain.addP2pkh(OWNER, 50_000n)] },
      ownerSigner: OWNER.signer,
    });
    const tx = decode(signed.hex);
    expectMirrored(tx, orders, 1);
    expectNoBurnNoMisdirection(tx, signed.sourceOutputs);
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('cancelWithSig() mirrors every refund at its own index, signed and as a placeholder draft', async () => {
    const chain = new Chain();
    const orders = batch(chain, { subDust: false });
    const signed = buildSignedCancelWithSigTransaction({ orders, ownerSigner: OWNER.signer });
    const tx = decode(signed.hex);
    expectMirrored(tx, orders, 0);
    expectNoBurnNoMisdirection(tx, signed.sourceOutputs);
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);

    const draft = buildCancelWithSigTransaction({ orders });
    const unsigned = decodeTransactionHex(draft.unsignedHex);
    expectMirrored(unsigned, orders, 0);
    expectNoBurnNoMisdirection(unsigned, draft.sourceOutputs);
  });

  it("cancelWithSig() lifts a sub-dust stray NFT refund to dust out of the other orders' allowances, keeping every token", async () => {
    const chain = new Chain();
    const orders = batch(chain, { subDust: true });
    const signed = buildSignedCancelWithSigTransaction({ orders, ownerSigner: OWNER.signer });
    const tx = decode(signed.hex);
    expectMirrored(tx, orders, 0);
    expectNoBurnNoMisdirection(tx, signed.sourceOutputs);
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('cancelWithSig() refuses a sub-dust stray NFT on its own (nothing can pay its fee) instead of dropping the NFT', () => {
    const chain = new Chain();
    const { order } = chain.addOrder(orderParams('sell'), { satoshis: 2000n, token: ft(CATEGORY, 5n) });
    const subDust = chain.addUtxoAt(order, { satoshis: 1n, token: nft(CATEGORY, 'none', '00') });
    const orders = [{ order, utxo: subDust }];
    expect(outcome(() => buildCancelWithSigTransaction({ orders }))).toBe('fee_exceeds_allowance');
    expect(outcome(() => buildSignedCancelWithSigTransaction({ orders, ownerSigner: OWNER.signer }))).toBe(
      'fee_exceeds_allowance',
    );
  });

  it('a stray reported without its token builds, and the covenant (rule R) plus the network reject it, so the token cannot be burned', async () => {
    const chain = new Chain();
    const { order } = chain.addOrder(orderParams('sell'), { satoshis: 2000n, token: ft(CATEGORY, 5n) });
    const real = chain.addUtxoAt(order, { satoshis: 20_000n, token: nft(CATEGORY, 'minting', '') });
    const lie = withoutToken(real);
    const draft = buildCancelTransaction({
      owner: { utxos: [chain.addP2pkh(OWNER, 5_000n)] },
      orders: [{ order, utxo: lie }],
    });
    const hex = signAsWallet(draft);
    const truth = [...draft.sourceOutputs.slice(0, 1), sourceOutputOf(real)];
    expect(verifyAll(decode(hex), truth)).not.toBe(true);
    await expect(chain.provider.sendRawTransaction(hex)).rejects.toThrow();
  });

  it('documents: the same stray listed twice in one batch is built into a draft spending it twice; the network rejects it', async () => {
    const chain = new Chain();
    const { order } = chain.addOrder(orderParams('sell'), { satoshis: 2000n, token: ft(CATEGORY, 5n) });
    const stray = chain.addUtxoAt(order, { satoshis: 20_000n, token: ft(CATEGORY, 10n) });
    const orders = [
      { order, utxo: stray },
      { order, utxo: stray },
    ];
    const draft = buildCancelTransaction({ owner: { utxos: [chain.addP2pkh(OWNER, 5_000n)] }, orders });
    expect(spentOutpoints(draft.unsignedHex).filter((spent) => spent === outpoint(stray))).toHaveLength(2);
    expect(outcome(() => signAndFinalize(draft))).not.toBe('accepted');
    await expect(chain.provider.sendRawTransaction(signAsWallet(draft))).rejects.toThrow();
    expect(
      outcome(() =>
        buildSignedCancelTransaction({
          orders,
          owner: { utxos: [chain.addP2pkh(OWNER, 5_000n)] },
          ownerSigner: OWNER.signer,
        }),
      ),
    ).not.toBe('accepted');
  });
});

describe('adversarial sell funding then cancel round trip (no token lost end to end)', () => {
  it('funding from three token UTXOs, then cancelling with the funding marker as input 0, returns every unit to the owner', async () => {
    const chain = new Chain();
    const tokens = [
      walletUtxo(chain, OWNER, 800n, ft(CATEGORY, 70n)),
      walletUtxo(chain, CHANGE_KEY, 800n, ft(CATEGORY, 20n)),
      walletUtxo(chain, RECEIVE_5, 800n, ft(CATEGORY, 15n)),
    ];
    const draft = fund(chain, 'sell', 100n, [...tokens, walletUtxo(chain, OWNER, 30_000n)]);
    const funding = signAndFinalize(draft);
    await chain.expectAccepted(funding.hex, funding.sourceOutputs);
    const fundingTx = decode(funding.hex);
    const asUtxo = (vout: number): Utxo => {
      const output = fundingTx.outputs[vout];
      if (output === undefined) throw new Error(`missing output ${vout}`);
      return {
        txid: funding.txid,
        vout,
        satoshis: output.valueSatoshis,
        ...(output.token && { token: ft(binToHex(output.token.category), output.token.amount) }),
      };
    };
    expect(tokenKey(fundingTx.outputs[3])).toBe(`${CATEGORY}|5|-`);
    const order = instantiateOrder(orderParams('sell'), chain.provider);
    const cancel = signAndFinalize(
      buildCancelTransaction({
        owner: { utxos: [asUtxo(3), asUtxo(2)] },
        orders: [{ order, utxo: asUtxo(0) }],
      }),
    );
    expect(spentOutpoints(cancel.hex)).toEqual([outpoint(asUtxo(2)), outpoint(asUtxo(0))]);
    expect(tokenKey(decode(cancel.hex).outputs[1])).toBe(`${CATEGORY}|100|-`);
    await chain.expectAccepted(cancel.hex, cancel.sourceOutputs);
  });
});
