import {
  binToHex,
  encodeLockingBytecodeP2sh32,
  encodeTransactionBch,
  hexToBin,
  type TransactionCommon,
} from '@bitauth/libauth';
import { MockNetworkProvider } from 'cashscript';
import { describe, expect, it } from 'vitest';
import {
  AtPriceError,
  buildExecuteTransaction,
  buildFundingTransaction,
  buildSignedCancelTransaction,
  decodeTransactionHex,
  finalizeWalletSignedTransaction,
  validateOrderShape,
  type FundingDraft,
  type OrderParams,
  type WalletUtxo,
} from '@atprice/core';
import {
  CATEGORY,
  Chain,
  OTHER_CATEGORY,
  OTHER_POOL_OWNER,
  orderParams,
  OWNER,
  STRANGER,
  key,
} from '../harness.js';
import { p2pkhUnlock, SIGHASH_ALL_UTXOS } from './support.js';

const POOL = { sats: 150_545_039n, tokens: 29_857n };
const BUY_VALUE = 10_003_000n;

/** The stable `reason` of an AtPrice error, `accepted` when nothing was thrown, or `other:<name>`. */
const outcome = (run: () => unknown): string => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return error instanceof AtPriceError ? error.reason : `other:${(error as Error).name}`;
  }
};

describe('adversarial buildExecuteTransaction: untrusted pool and order data', () => {
  const setup = () => {
    const chain = new Chain();
    const pool = chain.addPool(POOL);
    const { order, utxo } = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    return { chain, pool, order, utxo };
  };

  it('positive control: the honest fill is built, verified and accepted by the mock network', async () => {
    const { chain, pool, order, utxo } = setup();
    const built = buildExecuteTransaction(order, utxo, pool);
    await chain.expectAccepted(built.hex, built.sourceOutputs);
  });

  it('refuses a pool whose locking bytecode (as an indexer reports it) is not the Cauldron template', () => {
    const { pool, order, utxo } = setup();
    const fake = {
      ...pool,
      lockingBytecode: binToHex(encodeLockingBytecodeP2sh32(new Uint8Array(32).fill(9))),
    };
    expect(outcome(() => buildExecuteTransaction(order, utxo, fake))).toBe('not_cauldron_v0');
  });

  it('refuses a genuine pool reported under another owner hash', () => {
    const { pool, order, utxo } = setup();
    expect(
      outcome(() => buildExecuteTransaction(order, utxo, { ...pool, ownerPkh: OTHER_POOL_OWNER.pkh })),
    ).toBe('not_cauldron_v0');
  });

  it('refuses a pool of another token', () => {
    const { chain, order, utxo } = setup();
    const other = chain.addPool(POOL, { category: OTHER_CATEGORY, owner: OTHER_POOL_OWNER });
    expect(outcome(() => buildExecuteTransaction(order, utxo, other))).toBe('token_mismatch');
  });

  it('refuses a pool that carries an NFT', () => {
    const { pool, order, utxo } = setup();
    const nftPool = {
      ...pool,
      token: { ...pool.token, nft: { capability: 'minting' as const, commitment: '' } },
    };
    expect(outcome(() => buildExecuteTransaction(order, utxo, nftPool))).toBe('nft_present');
  });

  it('refuses an absolute fee one satoshi above maxNetworkFee', () => {
    const { pool, order, utxo } = setup();
    expect(
      outcome(() =>
        buildExecuteTransaction(order, utxo, pool, { fee: { kind: 'absolute', satoshis: 2001n } }),
      ),
    ).toBe('fee_above_cap');
  });

  it('refuses a negative absolute fee (outputs would exceed inputs) instead of returning a transaction', () => {
    const { pool, order, utxo } = setup();
    expect(
      outcome(() =>
        buildExecuteTransaction(order, utxo, pool, { fee: { kind: 'absolute', satoshis: -500n } }),
      ),
    ).not.toBe('accepted');
  });

  it('refuses a buy order UTXO that holds tokens', () => {
    const { chain, pool, order } = setup();
    const stray = chain.addUtxoAt(order, { satoshis: BUY_VALUE, token: { category: CATEGORY, amount: 1n } });
    expect(outcome(() => buildExecuteTransaction(order, stray, pool))).toBe('order_token_mismatch');
  });

  it('refuses an order UTXO whose reported locking bytecode is not the order covenant', () => {
    const { chain, pool, order, utxo } = setup();
    const twin = chain.addOrder(orderParams('buy', { nonce: Uint8Array.of(3, 3, 3, 3, 3, 3, 3, 3) }), {
      satoshis: BUY_VALUE,
    });
    // #then no transaction comes back (CashScript's own unlocker refuses before core's VM check runs)
    expect(() =>
      buildExecuteTransaction(order, { ...utxo, lockingBytecode: twin.order.contract.lockingBytecode }, pool),
    ).toThrow();
  });
});

describe('adversarial buildSignedCancelTransaction', () => {
  it('positive control: an 800-sat token stray at a sell address is refunded with every token, the owner input paying the fee', async () => {
    const chain = new Chain();
    const { order } = chain.addOrder(orderParams('sell'), {
      satoshis: 2000n,
      token: { category: CATEGORY, amount: 5n },
    });
    const stray = chain.addUtxoAt(order, {
      satoshis: 800n,
      token: { category: CATEGORY, amount: 1_000_000n },
    });
    const owner = chain.addP2pkh(OWNER, 100_000n);
    const signed = buildSignedCancelTransaction({
      orders: [{ order, utxo: stray }],
      owner: { utxos: [owner] },
      ownerSigner: OWNER.signer,
    });
    expect(decodeTransactionHex(signed.hex).outputs[1]?.token?.amount).toBe(1_000_000n);
    await chain.expectAccepted(signed.hex, signed.sourceOutputs);
  });

  it('refuses a signer that is not the order owner', () => {
    const chain = new Chain();
    const { order, utxo } = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    const owner = chain.addP2pkh(STRANGER, 100_000n);
    expect(
      outcome(() =>
        buildSignedCancelTransaction({
          orders: [{ order, utxo }],
          owner: { utxos: [owner] },
          ownerSigner: STRANGER.signer,
        }),
      ),
    ).toBe('owner_mismatch');
  });

  it('refuses to batch orders of two different owners', () => {
    const chain = new Chain();
    const mine = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    const theirs = chain.addOrder(orderParams('buy', { ownerPkh: STRANGER.pkh }), { satoshis: BUY_VALUE });
    const owner = chain.addP2pkh(OWNER, 100_000n);
    expect(
      outcome(() =>
        buildSignedCancelTransaction({
          orders: [{ order: mine.order, utxo: mine.utxo }, theirs],
          owner: { utxos: [owner] },
          ownerSigner: OWNER.signer,
        }),
      ),
    ).toBe('owner_mismatch');
  });

  it("refuses an order UTXO reported at another order's address", () => {
    const chain = new Chain();
    const mine = chain.addOrder(orderParams('buy'), { satoshis: BUY_VALUE });
    const twin = chain.addOrder(orderParams('buy', { nonce: Uint8Array.of(4, 4, 4, 4, 4, 4, 4, 4) }), {
      satoshis: BUY_VALUE,
    });
    const owner = chain.addP2pkh(OWNER, 100_000n);
    expect(
      outcome(() =>
        buildSignedCancelTransaction({
          orders: [{ order: mine.order, utxo: twin.utxo }],
          owner: { utxos: [owner] },
          ownerSigner: OWNER.signer,
        }),
      ),
    ).toBe('owner_utxo_invalid');
  });
});

describe('adversarial finalizeWalletSignedTransaction: a wallet that tampers with the funding transaction', () => {
  const provider = new MockNetworkProvider();
  const walletUtxos: WalletUtxo[] = [
    {
      txid: 'ab'.repeat(32),
      vout: 0,
      satoshis: 50_000_000n,
      lockingBytecode: binToHex(OWNER.lockingBytecode),
      pathName: 'receive',
      addressIndex: 0,
    },
  ];
  const draft: FundingDraft = buildFundingTransaction({
    params: orderParams('buy'),
    amount: 10_000_000n,
    minimumAmount: 1n,
    walletUtxos,
    network: 'chipnet',
    provider,
  });

  /** Signs every wallet input of `transaction` as an honest wallet would (ALL|UTXOS). */
  const sign = (transaction: TransactionCommon): string => {
    const sourceOutputs = [...draft.sourceOutputs];
    const signed: TransactionCommon = {
      ...transaction,
      inputs: transaction.inputs.map((input) => ({ ...input })),
    };
    signed.inputs.forEach((input, index) => {
      const unlock = p2pkhUnlock(OWNER, SIGHASH_ALL_UTXOS);
      input.unlockingBytecode = typeof unlock === 'function' ? unlock(signed, sourceOutputs, index) : unlock;
    });
    return binToHex(encodeTransactionBch(signed));
  };
  const unsigned = (): TransactionCommon => decodeTransactionHex(draft.unsignedHex);

  it('positive control: the honestly signed funding transaction is finalized', () => {
    expect(outcome(() => finalizeWalletSignedTransaction(draft, sign(unsigned())))).toBe('accepted');
  });

  it('refuses a wallet that sends the order output to its own address (and signs that)', () => {
    const tx = unsigned();
    const order = tx.outputs[0];
    if (order === undefined) throw new Error('no order output');
    tx.outputs[0] = { ...order, lockingBytecode: key(0x55).lockingBytecode };
    expect(outcome(() => finalizeWalletSignedTransaction(draft, sign(tx)))).toBe(
      'wallet_changed_transaction',
    );
  });

  it('refuses a wallet that rewrites the OP_RETURN record (for example a lower minOut)', () => {
    const tx = unsigned();
    const record = tx.outputs[1];
    if (record === undefined) throw new Error('no record output');
    const bytes = Uint8Array.from(record.lockingBytecode);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    tx.outputs[1] = { ...record, lockingBytecode: bytes };
    expect(outcome(() => finalizeWalletSignedTransaction(draft, sign(tx)))).toBe(
      'wallet_changed_transaction',
    );
  });

  it('refuses a wallet that adds an output paying itself from the change', () => {
    const tx = unsigned();
    const change = tx.outputs[2];
    if (change === undefined) throw new Error('no change output');
    tx.outputs[2] = { ...change, valueSatoshis: change.valueSatoshis - 10_000n };
    tx.outputs.push({ lockingBytecode: key(0x55).lockingBytecode, valueSatoshis: 10_000n });
    expect(outcome(() => finalizeWalletSignedTransaction(draft, sign(tx)))).toBe(
      'wallet_changed_transaction',
    );
  });

  it('refuses a signed hex with a trailing byte', () => {
    expect(outcome(() => finalizeWalletSignedTransaction(draft, `${sign(unsigned())}00`))).toBe(
      'decode_failed',
    );
  });
});

describe('adversarial params at the funding boundary (values that bypass the TypeScript types)', () => {
  const provider = new MockNetworkProvider();
  const walletUtxos: WalletUtxo[] = [
    {
      txid: 'cd'.repeat(32),
      vout: 0,
      satoshis: 50_000_000n,
      lockingBytecode: binToHex(OWNER.lockingBytecode),
      pathName: 'receive',
      addressIndex: 0,
    },
  ];
  const fund = (params: OrderParams, feePerByte?: bigint) =>
    buildFundingTransaction({
      params,
      amount: 100_000n,
      minimumAmount: 1n,
      walletUtxos,
      network: 'chipnet',
      provider,
      ...(feePerByte !== undefined && { feePerByte }),
    });
  const untyped = (value: unknown): bigint => value as bigint;

  it.each([
    ['minOut 1.5 (number)', { minOut: untyped(1.5) }],
    ['minOut NaN', { minOut: untyped(Number.NaN) }],
    ['maxNetworkFee NaN', { maxNetworkFee: untyped(Number.NaN) }],
    ['maxNetworkFee 1000.5 (number)', { maxNetworkFee: untyped(1000.5) }],
  ] as const)('never produces a funding draft for %s', (_name, overrides) => {
    expect(outcome(() => fund(orderParams('buy', overrides)))).not.toBe('accepted');
  });

  it('documents: validateOrderShape itself passes non-bigint minOut 1.5 and NaN (mixed number/bigint comparisons), so the refusal above comes from CashScript, not from the validator', () => {
    expect(outcome(() => validateOrderShape(orderParams('buy', { minOut: untyped(1.5) })))).toBe('accepted');
    expect(outcome(() => validateOrderShape(orderParams('buy', { minOut: untyped(Number.NaN) })))).toBe(
      'accepted',
    );
  });

  it.each([-1n, 0n])('never produces a funding draft at feePerByte %i', (feePerByte) => {
    expect(outcome(() => fund(orderParams('buy'), feePerByte))).not.toBe('accepted');
  });

  it("documents: an unlisted category is funded, because the allowlist is the caller's check (core-api.md)", () => {
    expect(outcome(() => fund(orderParams('buy', { tokenCategory: OTHER_CATEGORY })))).toBe('accepted');
  });

  it('positive control: the order output of a valid buy draft pays the derived covenant address', () => {
    const draft = fund(orderParams('buy'));
    expect(
      binToHex(decodeTransactionHex(draft.unsignedHex).outputs[0]?.lockingBytecode ?? new Uint8Array()),
    ).toBe(binToHex(draft.orderLockingBytecode));
    expect(hexToBin(binToHex(draft.record))[0]).toBe(0x6a);
  });
});
