import {
  binToHex,
  encodeLockingBytecodeP2sh20,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { MockNetworkProvider } from 'cashscript';
import { describe, expect, it } from 'vitest';
import {
  buildFundingTransaction,
  InvalidOrderParamsError,
  MAX_INT64,
  orderAmountFromFunding,
  ownerPkhFromPublicKey,
  recipientLockingBytecodeFromAddress,
  validateOrderParams,
  type OrderParams,
  type OrderParamsViolation,
  type WalletUtxo,
} from '@atprice/core';
import { CATEGORY, Chain, OTHER_CATEGORY, orderParams, OWNER } from '../harness.js';
import { expectAcceptedRaw, expectCovenantRejects, rawBuy } from './support.js';

const DOMAIN = { supportedTokenCategories: [CATEGORY] };

const violation = (run: () => unknown): OrderParamsViolation | 'accepted' => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidOrderParamsError);
    return (error as InvalidOrderParamsError).reason;
  }
};

const P2PK = Uint8Array.from([0x21, 0x02, ...new Uint8Array(32).fill(0x33), 0xac]);
const BARE_MULTISIG = Uint8Array.from([0x51, 0x21, 0x02, ...new Uint8Array(32).fill(0x44), 0x51, 0xae]);
const OP_RETURN_RECIPIENT = Uint8Array.of(0x6a, 0x01, 0x01);
const ALMOST_P2PKH = Uint8Array.from([0x76, 0xa9, 0x14, ...new Uint8Array(20).fill(1), 0x88, 0xad]);

describe('adversarial validateOrderParams', () => {
  it('accepts the harness defaults on both sides (control)', () => {
    expect(violation(() => validateOrderParams(orderParams('buy'), DOMAIN))).toBe('accepted');
    expect(violation(() => validateOrderParams(orderParams('sell'), DOMAIN))).toBe('accepted');
  });

  it.each<[string, OrderParams, OrderParamsViolation]>([
    ['empty ownerPkh', orderParams('buy', { ownerPkh: new Uint8Array() }), 'owner_pkh_length'],
    ['19-byte ownerPkh', orderParams('buy', { ownerPkh: new Uint8Array(19) }), 'owner_pkh_length'],
    ['32-byte ownerPkh', orderParams('buy', { ownerPkh: new Uint8Array(32) }), 'owner_pkh_length'],
    [
      'P2PK recipient (35 bytes like P2SH32)',
      orderParams('buy', { recipientLockingBytecode: P2PK }),
      'recipient_template',
    ],
    [
      'bare multisig recipient',
      orderParams('buy', { recipientLockingBytecode: BARE_MULTISIG }),
      'recipient_template',
    ],
    [
      'OP_RETURN recipient',
      orderParams('buy', { recipientLockingBytecode: OP_RETURN_RECIPIENT }),
      'recipient_template',
    ],
    [
      'P2PKH lookalike ending in CHECKSIGVERIFY',
      orderParams('buy', { recipientLockingBytecode: ALMOST_P2PKH }),
      'recipient_template',
    ],
    [
      'empty recipient',
      orderParams('buy', { recipientLockingBytecode: new Uint8Array() }),
      'recipient_template',
    ],
    [
      'uppercase category',
      orderParams('buy', { tokenCategory: CATEGORY.toUpperCase() }),
      'token_category_format',
    ],
    [
      '0x-prefixed category',
      orderParams('buy', { tokenCategory: `0x${CATEGORY.slice(2)}` }),
      'token_category_format',
    ],
    ['63-char category', orderParams('buy', { tokenCategory: CATEGORY.slice(1) }), 'token_category_format'],
    [
      'category with trailing newline',
      orderParams('buy', { tokenCategory: `${CATEGORY}\n` }),
      'token_category_format',
    ],
    [
      'VM-order (reversed) allowlisted category',
      orderParams('buy', { tokenCategory: binToHex(hexToBin(CATEGORY).reverse()) }),
      'token_category_unsupported',
    ],
    [
      'unlisted category',
      orderParams('buy', { tokenCategory: OTHER_CATEGORY }),
      'token_category_unsupported',
    ],
    ['buy minOut 0', orderParams('buy', { minOut: 0n }), 'min_out_range'],
    ['buy minOut -1', orderParams('buy', { minOut: -1n }), 'min_out_range'],
    ['buy minOut 2^63', orderParams('buy', { minOut: MAX_INT64 + 1n }), 'min_out_range'],
    ['sell minOut 2000 (P = 0)', orderParams('sell', { minOut: 2000n }), 'min_out_range'],
    ['maxNetworkFee 999', orderParams('buy', { maxNetworkFee: 999n }), 'max_network_fee_range'],
    ['maxNetworkFee 5001', orderParams('buy', { maxNetworkFee: 5001n }), 'max_network_fee_range'],
    ['maxNetworkFee 0', orderParams('buy', { maxNetworkFee: 0n }), 'max_network_fee_range'],
    ['maxNetworkFee negative', orderParams('buy', { maxNetworkFee: -1n }), 'max_network_fee_range'],
    ['7-byte nonce', orderParams('buy', { nonce: new Uint8Array(7).fill(1) }), 'nonce_length'],
    ['9-byte nonce', orderParams('buy', { nonce: new Uint8Array(9).fill(1) }), 'nonce_length'],
    ['all-zero nonce', orderParams('buy', { nonce: new Uint8Array(8) }), 'nonce_zero'],
  ])('rejects %s', (_name, params, reason) => {
    expect(violation(() => validateOrderParams(params, DOMAIN))).toBe(reason);
  });

  it('accepts minOut boundaries exactly (buy 1, sell 2001, both 2^63-1) and fee 1000 / 5000', () => {
    for (const params of [
      orderParams('buy', { minOut: 1n, maxNetworkFee: 1000n }),
      orderParams('sell', { minOut: 2001n, maxNetworkFee: 5000n }),
      orderParams('buy', { minOut: MAX_INT64 }),
      orderParams('sell', { minOut: MAX_INT64 }),
      orderParams('buy', {
        recipientLockingBytecode: encodeLockingBytecodeP2sh20(new Uint8Array(20).fill(3)),
      }),
    ]) {
      expect(violation(() => validateOrderParams(params, DOMAIN))).toBe('accepted');
    }
  });
});

describe('adversarial key and address inputs', () => {
  it('rejects an uncompressed key, a 0x04-prefixed 33-byte key and an off-curve point', () => {
    const uncompressed = Uint8Array.from([0x04, ...new Uint8Array(64).fill(1)]);
    const wrongPrefix = Uint8Array.from([0x04, ...OWNER.publicKey.slice(1)]);
    const offCurve = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0xff)]);
    for (const key of [uncompressed, wrongPrefix, offCurve]) {
      expect(violation(() => ownerPkhFromPublicKey(key))).toBe('owner_public_key_invalid');
    }
    expect(ownerPkhFromPublicKey(OWNER.publicKey)).toEqual(OWNER.pkh);
  });

  it('rejects a mainnet address for a chipnet order and a chipnet address for mainnet', () => {
    const address = (prefix: 'bitcoincash' | 'bchtest'): string => {
      const result = lockingBytecodeToCashAddress({ bytecode: OWNER.lockingBytecode, prefix });
      if (typeof result === 'string') throw new Error(result);
      return result.address;
    };
    const mainnet = address('bitcoincash');
    const chipnet = address('bchtest');
    expect(recipientLockingBytecodeFromAddress(chipnet, 'chipnet')).toEqual(OWNER.lockingBytecode);
    expect(violation(() => recipientLockingBytecodeFromAddress(mainnet, 'chipnet'))).toBe(
      'recipient_network',
    );
    expect(violation(() => recipientLockingBytecodeFromAddress(chipnet, 'mainnet'))).toBe(
      'recipient_network',
    );
    const corrupted = `${mainnet.slice(0, -1)}${mainnet.endsWith('q') ? 'p' : 'q'}`;
    expect(violation(() => recipientLockingBytecodeFromAddress(corrupted, 'mainnet'))).toBe(
      'recipient_address',
    );
  });
});

describe('adversarial orderAmountFromFunding (indexer gate)', () => {
  const buy = orderParams('buy');
  const sell = orderParams('sell');

  it('accepts exactly-prescribed funding on both sides (control)', () => {
    expect(orderAmountFromFunding(buy, { satoshis: 10_003_000n }, 1n)).toBe(10_000_000n);
    expect(
      orderAmountFromFunding(sell, { satoshis: 2000n, token: { category: CATEGORY, amount: 5n } }, 1n),
    ).toBe(5n);
  });

  it.each([
    [
      'buy holding tokens',
      buy,
      { satoshis: 10_003_000n, token: { category: CATEGORY, amount: 1n } },
      'funding_mismatch',
    ],
    ['buy that cannot cover payout + fee', buy, { satoshis: 3000n }, 'amount_range'],
    ['buy below the payout + fee', buy, { satoshis: 2999n }, 'amount_range'],
    ['sell without tokens', sell, { satoshis: 2000n }, 'funding_mismatch'],
    [
      'sell of another category',
      sell,
      { satoshis: 2000n, token: { category: OTHER_CATEGORY, amount: 5n } },
      'funding_mismatch',
    ],
    [
      'sell with an NFT',
      sell,
      {
        satoshis: 2000n,
        token: { category: CATEGORY, amount: 5n, nft: { capability: 'none', commitment: '' } },
      },
      'funding_mismatch',
    ],
    [
      'sell with 2001 sats',
      sell,
      { satoshis: 2001n, token: { category: CATEGORY, amount: 5n } },
      'funding_mismatch',
    ],
    [
      'sell with 1999 sats',
      sell,
      { satoshis: 1999n, token: { category: CATEGORY, amount: 5n } },
      'funding_mismatch',
    ],
  ] as const)('rejects %s', (_name, params, output, reason) => {
    expect(violation(() => orderAmountFromFunding(params, output, 1n))).toBe(reason);
  });
});

describe('adversarial buildFundingTransaction: the step that commits funds must enforce the domain', () => {
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
    {
      txid: 'cd'.repeat(32),
      vout: 0,
      satoshis: 1000n,
      token: { category: CATEGORY, amount: 1_000_000n },
      lockingBytecode: binToHex(OWNER.lockingBytecode),
      pathName: 'receive',
      addressIndex: 0,
    },
  ];
  const fund = (params: OrderParams): unknown =>
    buildFundingTransaction({
      params,
      amount: 100_000n,
      minimumAmount: 1n,
      walletUtxos,
      network: 'chipnet',
      provider,
    });

  it('funds valid params on both sides (control)', () => {
    expect(violation(() => fund(orderParams('buy')))).toBe('accepted');
    expect(violation(() => fund(orderParams('sell')))).toBe('accepted');
  });

  it.each<[string, OrderParams, OrderParamsViolation]>([
    [
      'an all-zero nonce (order can never execute)',
      orderParams('buy', { nonce: new Uint8Array(8) }),
      'nonce_zero',
    ],
    [
      'maxNetworkFee 1,000,000 (filler may burn it all)',
      orderParams('buy', { maxNetworkFee: 1_000_000n }),
      'max_network_fee_range',
    ],
    [
      'maxNetworkFee 0 (order can never relay a fill)',
      orderParams('buy', { maxNetworkFee: 0n }),
      'max_network_fee_range',
    ],
    ['a P2PK recipient', orderParams('buy', { recipientLockingBytecode: P2PK }), 'recipient_template'],
    ['buy minOut 0', orderParams('buy', { minOut: 0n }), 'min_out_range'],
    ['sell minOut 2000 (P = 0)', orderParams('sell', { minOut: 2000n }), 'min_out_range'],
  ])('refuses to fund %s', (_name, params, reason) => {
    expect(violation(() => fund(params))).toBe(reason);
  });
});

describe('why funding must validate: an out-of-domain zero nonce on chain', () => {
  it('a funded zero-nonce order can never be executed: the covenant fails on its first require', () => {
    // #given a zero-nonce buy order put on chain by hand (buildFundingTransaction refuses it since r1)
    const chain = new Chain();
    const pool = chain.addPool({ sats: 150_545_039n, tokens: 29_857n });
    const { order, utxo } = chain.addOrder(orderParams('buy', { nonce: new Uint8Array(8) }), {
      satoshis: 10_003_000n,
    });
    // #when anyone tries the otherwise perfect best fill
    // #then only cancel can ever move the funds
    expectCovenantRejects(rawBuy(order, utxo, pool), order, 'nonce must be non-zero', { poolPasses: true });
  });
});

describe('why funding must validate: an out-of-domain maxNetworkFee on chain', () => {
  it('a funded buy with maxNetworkFee 1,000,000 can be filled with a 1,000,000-sat miner fee', async () => {
    // #given a buy funded by hand with an out-of-domain fee allowance (buildFundingTransaction refuses it since r1)
    const maxNetworkFee = 1_000_000n;
    const chain = new Chain();
    const pool = chain.addPool({ sats: 150_545_039n, tokens: 29_857n });
    const spend = 100_000n;
    const { order, utxo } = chain.addOrder(orderParams('buy', { maxNetworkFee }), {
      satoshis: spend + 1000n + maxNetworkFee,
    });
    // #when a filler (or the miner itself) puts only `spend` into the pool
    // #then the covenant accepts and the whole allowance goes to the miner
    await expectAcceptedRaw(chain, rawBuy(order, utxo, pool, { bchIn: spend }));
  });
});
