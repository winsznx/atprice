import { hexToBin, type Output, type TransactionCommon } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import {
  assessFunding,
  assessOrderInstance,
  decodeTransactionHex,
  encodeOrderRecord,
  type FundingSupport,
  type MarketDomain,
} from '../src/index.js';
import { buyParams, CATEGORY, OTHER_CATEGORY, OWNER, sellParams, STRANGER } from './support/fixtures.js';
import { CHANGE_KEY, fund, walletUtxo } from './support/funding.js';

const DOMAIN: MarketDomain = {
  markets: [{ tokenCategory: CATEGORY, minimumAmount: { buy: 10_000n, sell: 100n } }],
};
const BUY_AMOUNT = 100_000n;
const BUY_VALUE = BUY_AMOUNT + 1000n + 2000n;

const buyFunding = (): TransactionCommon =>
  decodeTransactionHex(
    fund(buyParams(), BUY_AMOUNT, [walletUtxo(OWNER, 'receive', 0, 500_000n)]).unsignedHex,
  );

const sellFundingWithTokenChange = (): TransactionCommon =>
  decodeTransactionHex(
    fund(sellParams(), 250_000n, [
      walletUtxo(OWNER, 'receive', 0, 800n, { category: CATEGORY, amount: 1_000_000n }),
      walletUtxo(CHANGE_KEY, 'change', 3, 20_000n),
    ]).unsignedHex,
  );

const withOutputs = (transaction: TransactionCommon, outputs: Output[]): TransactionCommon => ({
  ...transaction,
  outputs,
});

const replaceOutput = (transaction: TransactionCommon, vout: number, output: Output): TransactionCommon =>
  withOutputs(
    transaction,
    transaction.outputs.map((original, index) => (index === vout ? output : original)),
  );

const fungible = (category: string, amount: bigint): NonNullable<Output['token']> => ({
  category: hexToBin(category),
  amount,
});

const reasonOf = (support: FundingSupport): string => (support.supported ? 'supported' : support.reason);

describe('assessFunding', () => {
  it('supports a buy funding built by buildFundingTransaction', () => {
    expect(assessFunding(buyFunding(), DOMAIN)).toEqual({
      supported: true,
      params: buyParams(),
      fundingVout: 0,
      amount: BUY_AMOUNT,
    });
  });

  it('supports a sell funding whose token change sits on output 3', () => {
    const support = assessFunding(sellFundingWithTokenChange(), DOMAIN);
    expect(support).toEqual({ supported: true, params: sellParams(), fundingVout: 0, amount: 250_000n });
  });

  it('refuses a token-carrying buy funding but keeps its params for a cancel-only order', () => {
    const tx = buyFunding();
    const order = tx.outputs[0];
    if (order === undefined) throw new Error('missing order output');
    const support = assessFunding(replaceOutput(tx, 0, { ...order, token: fungible(CATEGORY, 5n) }), DOMAIN);
    expect(support).toMatchObject({ supported: false, reason: 'funding_mismatch', fundingVout: 0 });
    expect(support.params).toEqual(buyParams());
  });

  it('refuses a buy below the market minimum', () => {
    const tx = decodeTransactionHex(
      fund(buyParams(), 9_999n, [walletUtxo(OWNER, 'receive', 0, 50_000n)]).unsignedHex,
    );
    expect(reasonOf(assessFunding(tx, DOMAIN))).toBe('amount_below_minimum');
    const atMinimum = decodeTransactionHex(
      fund(buyParams(), 10_000n, [walletUtxo(OWNER, 'receive', 0, 50_000n)]).unsignedHex,
    );
    expect(reasonOf(assessFunding(atMinimum, DOMAIN))).toBe('supported');
  });

  it('refuses a market that is not on the allowlist', () => {
    expect(reasonOf(assessFunding(buyFunding(), { markets: [] }))).toBe('token_category_unsupported');
  });

  it('refuses outputs other than the order, the record, owner change and sell token change', () => {
    const tx = buyFunding();
    const owner = tx.outputs[2];
    if (owner === undefined) throw new Error('missing owner output');
    const stranger = { lockingBytecode: STRANGER.lockingBytecode, valueSatoshis: 1000n };
    expect(reasonOf(assessFunding(withOutputs(tx, [...tx.outputs, stranger]), DOMAIN))).toBe(
      'unexpected_output',
    );
    expect(reasonOf(assessFunding(withOutputs(tx, [...tx.outputs, owner]), DOMAIN))).toBe(
      'unexpected_output',
    );
    const buyTokenChange = { ...owner, token: fungible(CATEGORY, 3n) };
    expect(reasonOf(assessFunding(withOutputs(tx, [...tx.outputs, buyTokenChange]), DOMAIN))).toBe(
      'unexpected_output',
    );

    const sell = sellFundingWithTokenChange();
    const change = sell.outputs[3];
    if (change === undefined) throw new Error('missing token change');
    const foreignChange = { ...change, token: fungible(OTHER_CATEGORY, 3n) };
    expect(reasonOf(assessFunding(replaceOutput(sell, 3, foreignChange), DOMAIN))).toBe('unexpected_output');
    const nftChange = {
      ...change,
      token: {
        ...fungible(CATEGORY, 3n),
        nft: { capability: 'none' as const, commitment: new Uint8Array() },
      },
    };
    expect(reasonOf(assessFunding(replaceOutput(sell, 3, nftChange), DOMAIN))).toBe('unexpected_output');
  });

  it('names a missing, duplicated or foreign record and a record whose order output is absent', () => {
    const tx = buyFunding();
    const record = tx.outputs[1];
    if (record === undefined) throw new Error('missing record');
    expect(
      reasonOf(
        assessFunding(
          withOutputs(
            tx,
            tx.outputs.filter((_, i) => i !== 1),
          ),
          DOMAIN,
        ),
      ),
    ).toBe('record_missing');
    expect(reasonOf(assessFunding(withOutputs(tx, [...tx.outputs, record]), DOMAIN))).toBe('record_multiple');
    const foreign = {
      ...record,
      lockingBytecode: Uint8Array.from(record.lockingBytecode, (byte, i) => (i === 2 ? 0x58 : byte)),
    };
    expect(reasonOf(assessFunding(replaceOutput(tx, 1, foreign), DOMAIN))).toBe('bad_magic');
    const otherOrder = encodeOrderRecord(buyParams({ nonce: Uint8Array.of(1, 1, 1, 1, 1, 1, 1, 1) }));
    expect(
      reasonOf(
        assessFunding(replaceOutput(tx, 1, { lockingBytecode: otherOrder, valueSatoshis: 0n }), DOMAIN),
      ),
    ).toBe('order_output_missing');
    const order = tx.outputs[0];
    if (order === undefined) throw new Error('missing order output');
    expect(reasonOf(assessFunding(withOutputs(tx, [...tx.outputs, order]), DOMAIN))).toBe(
      'order_output_multiple',
    );
  });
});

describe('assessOrderInstance (other UTXOs at an order address)', () => {
  it('marks a token UTXO sent to a valid buy order address unsupported', () => {
    const support = assessOrderInstance(
      buyParams(),
      { satoshis: 1000n, token: { category: CATEGORY, amount: 40n } },
      DOMAIN,
    );
    expect(support).toMatchObject({ supported: false, reason: 'funding_mismatch' });
  });

  it('supports a second deposit at a buy address that is itself an exact funding', () => {
    expect(assessOrderInstance(buyParams(), { satoshis: BUY_VALUE }, DOMAIN)).toEqual({
      supported: true,
      amount: BUY_AMOUNT,
    });
  });

  it('applies the sell-side rules to a stray at a sell address', () => {
    const sell = sellParams();
    expect(
      assessOrderInstance(sell, { satoshis: 2000n, token: { category: CATEGORY, amount: 100n } }, DOMAIN),
    ).toEqual({ supported: true, amount: 100n });
    expect(
      assessOrderInstance(sell, { satoshis: 2000n, token: { category: CATEGORY, amount: 99n } }, DOMAIN),
    ).toMatchObject({ supported: false, reason: 'amount_below_minimum' });
    expect(assessOrderInstance(sell, { satoshis: 50_000n }, DOMAIN)).toMatchObject({
      supported: false,
      reason: 'funding_mismatch',
    });
    expect(
      assessOrderInstance(
        sell,
        {
          satoshis: 2000n,
          token: { category: CATEGORY, amount: 500n, nft: { capability: 'none', commitment: '' } },
        },
        DOMAIN,
      ),
    ).toMatchObject({ supported: false, reason: 'funding_mismatch' });
  });

  it('marks every instance of an out-of-domain order unsupported', () => {
    expect(
      assessOrderInstance(buyParams({ maxNetworkFee: 999n }), { satoshis: BUY_VALUE }, DOMAIN),
    ).toMatchObject({
      supported: false,
      reason: 'max_network_fee_range',
    });
  });
});
