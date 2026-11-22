import { binToHex, hexToBin, secp256k1 } from '@bitauth/libauth';
import { ElectrumNetworkProvider, MockNetworkProvider } from 'cashscript';
import { describe, expect, it } from 'vitest';
import {
  AtPriceError,
  DEFAULT_MAX_NETWORK_FEE,
  instantiateOrder,
  InvalidOrderParamsError,
  MAX_INT64,
  MAX_NETWORK_FEE_CEILING,
  MAX_NETWORK_FEE_FLOOR,
  minimumMinOut,
  orderAddresses,
  orderAmountFromFunding,
  orderFunding,
  orderRedeemScript,
  ownerLockingBytecode,
  ownerPkhFromPublicKey,
  recipientLockingBytecodeFromAddress,
  recipientType,
  validateOrderParams,
  validateOrderShape,
  type OrderParamsViolation,
} from '../src/index.js';
import {
  buyParams,
  CATEGORY,
  OTHER_CATEGORY,
  OWNER,
  P2SH20_RECIPIENT,
  P2SH32_RECIPIENT,
  privateKeyFrom,
  sellParams,
} from './support/fixtures.js';

const DOMAIN = { supportedTokenCategories: [CATEGORY] };

const reasonOf = (action: () => unknown): OrderParamsViolation | undefined => {
  try {
    action();
  } catch (error) {
    if (error instanceof InvalidOrderParamsError) return error.reason;
    throw error;
  }
  return undefined;
};

describe('ownerPkhFromPublicKey', () => {
  it('hashes a valid compressed key', () => {
    expect(ownerPkhFromPublicKey(OWNER.publicKey)).toEqual(OWNER.pkh);
  });

  it('rejects uncompressed, malformed and off-curve keys', () => {
    const uncompressed = secp256k1.derivePublicKeyUncompressed(privateKeyFrom(1));
    if (typeof uncompressed === 'string') throw new Error(uncompressed);
    const xAboveFieldPrime = Uint8Array.of(0x02, ...new Uint8Array(32).fill(0xff));
    const candidates = [
      uncompressed,
      OWNER.publicKey.slice(0, 32),
      Uint8Array.of(0x04, ...OWNER.publicKey.slice(1)),
      new Uint8Array(33),
      xAboveFieldPrime,
    ];
    for (const key of candidates)
      expect(reasonOf(() => ownerPkhFromPublicKey(key))).toBe('owner_public_key_invalid');
  });
});

describe('recipients', () => {
  it('classifies the three allowed templates', () => {
    expect(recipientType(OWNER.lockingBytecode)).toBe('p2pkh');
    expect(recipientType(P2SH20_RECIPIENT)).toBe('p2sh20');
    expect(recipientType(P2SH32_RECIPIENT)).toBe('p2sh32');
    expect(recipientType(hexToBin('6a00'))).toBeUndefined();
  });

  it('decodes a recipient address on the right network only', () => {
    const chipnet = orderAddresses(buyParams(), 'chipnet').address;
    const mainnet = orderAddresses(buyParams(), 'mainnet').address;
    expect(recipientLockingBytecodeFromAddress(chipnet, 'chipnet')).toEqual(
      orderAddresses(buyParams(), 'chipnet').lockingBytecode,
    );
    expect(reasonOf(() => recipientLockingBytecodeFromAddress(mainnet, 'chipnet'))).toBe('recipient_network');
    expect(reasonOf(() => recipientLockingBytecodeFromAddress('bchtest:not-an-address', 'chipnet'))).toBe(
      'recipient_address',
    );
  });

  it('defaults to the owner P2PKH', () => {
    expect(ownerLockingBytecode(OWNER.pkh)).toEqual(OWNER.lockingBytecode);
    expect(reasonOf(() => ownerLockingBytecode(new Uint8Array(19)))).toBe('owner_pkh_length');
  });
});

describe('validateOrderParams', () => {
  it('accepts valid buy and sell orders, including every bound exactly', () => {
    expect(() => validateOrderParams(buyParams(), DOMAIN)).not.toThrow();
    expect(() => validateOrderParams(sellParams(), DOMAIN)).not.toThrow();
    expect(() =>
      validateOrderParams(buyParams({ minOut: MAX_INT64, maxNetworkFee: MAX_NETWORK_FEE_FLOOR }), DOMAIN),
    ).not.toThrow();
    expect(() =>
      validateOrderParams(
        sellParams({ maxNetworkFee: MAX_NETWORK_FEE_CEILING, recipientLockingBytecode: P2SH32_RECIPIENT }),
        DOMAIN,
      ),
    ).not.toThrow();
    expect(() =>
      validateOrderParams(buyParams({ recipientLockingBytecode: P2SH20_RECIPIENT }), DOMAIN),
    ).not.toThrow();
    expect(
      DEFAULT_MAX_NETWORK_FEE >= MAX_NETWORK_FEE_FLOOR && DEFAULT_MAX_NETWORK_FEE <= MAX_NETWORK_FEE_CEILING,
    ).toBe(true);
  });

  const cases: [string, Parameters<typeof validateOrderParams>[0], OrderParamsViolation][] = [
    ['ownerPkh length', buyParams({ ownerPkh: new Uint8Array(21) }), 'owner_pkh_length'],
    ['bare script recipient', buyParams({ recipientLockingBytecode: hexToBin('51') }), 'recipient_template'],
    [
      'P2PK recipient',
      buyParams({ recipientLockingBytecode: hexToBin(`21${binToHex(OWNER.publicKey)}ac`) }),
      'recipient_template',
    ],
    ['uppercase category', buyParams({ tokenCategory: CATEGORY.toUpperCase() }), 'token_category_format'],
    ['short category', buyParams({ tokenCategory: CATEGORY.slice(2) }), 'token_category_format'],
    ['unsupported category', buyParams({ tokenCategory: OTHER_CATEGORY }), 'token_category_unsupported'],
    ['buy minOut 0', buyParams({ minOut: 0n }), 'min_out_range'],
    ['sell minOut 2000', sellParams({ minOut: 2000n }), 'min_out_range'],
    ['minOut above int64', buyParams({ minOut: MAX_INT64 + 1n }), 'min_out_range'],
    ['fee below floor', buyParams({ maxNetworkFee: MAX_NETWORK_FEE_FLOOR - 1n }), 'max_network_fee_range'],
    [
      'fee above ceiling',
      buyParams({ maxNetworkFee: MAX_NETWORK_FEE_CEILING + 1n }),
      'max_network_fee_range',
    ],
    ['nonce length', buyParams({ nonce: new Uint8Array(7).fill(1) }), 'nonce_length'],
    ['zero nonce', buyParams({ nonce: new Uint8Array(8) }), 'nonce_zero'],
  ];
  it.each(cases)('rejects %s', (_name, params, reason) => {
    expect(reasonOf(() => validateOrderParams(params, DOMAIN))).toBe(reason);
  });

  it.each(cases.filter(([, , reason]) => reason !== 'token_category_unsupported'))(
    'validateOrderShape rejects %s for the same reason',
    (_name, params, reason) => {
      expect(reasonOf(() => validateOrderShape(params))).toBe(reason);
    },
  );

  it('validateOrderShape leaves only the market allowlist to the caller', () => {
    expect(() => validateOrderShape(buyParams({ tokenCategory: OTHER_CATEGORY }))).not.toThrow();
    expect(reasonOf(() => validateOrderParams(buyParams({ tokenCategory: OTHER_CATEGORY }), DOMAIN))).toBe(
      'token_category_unsupported',
    );
  });

  it('uses a sell minOut floor of 2001 and a buy floor of 1', () => {
    expect(minimumMinOut('buy')).toBe(1n);
    expect(minimumMinOut('sell')).toBe(2001n);
  });

  it('raises errors that are AtPriceErrors with a stable name', () => {
    try {
      validateOrderParams(buyParams({ nonce: new Uint8Array(8) }), DOMAIN);
    } catch (error) {
      expect(error).toBeInstanceOf(AtPriceError);
      expect((error as Error).name).toBe('InvalidOrderParamsError');
    }
  });
});

describe('order funding', () => {
  it('computes buy V = spend + 1000 + maxNetworkFee and sell V = 2000 + tokens', () => {
    expect(orderFunding(buyParams(), 50_000n, 10_000n)).toEqual({ satoshis: 53_000n, tokenAmount: 0n });
    expect(orderFunding(sellParams(), 777n, 1n)).toEqual({ satoshis: 2000n, tokenAmount: 777n });
  });

  it('enforces the market minimum and the int64 range', () => {
    expect(reasonOf(() => orderFunding(buyParams(), 9_999n, 10_000n))).toBe('amount_below_minimum');
    expect(reasonOf(() => orderFunding(buyParams(), 0n, 0n))).toBe('amount_range');
    expect(reasonOf(() => orderFunding(sellParams(), MAX_INT64 + 1n, 1n))).toBe('amount_range');
  });

  it('recovers the amount from an observed output and rejects anything else', () => {
    const buy = buyParams();
    expect(orderAmountFromFunding(buy, { satoshis: 53_000n }, 10_000n)).toBe(50_000n);
    expect(
      reasonOf(() =>
        orderAmountFromFunding(buy, { satoshis: 53_000n, token: { category: CATEGORY, amount: 1n } }, 1n),
      ),
    ).toBe('funding_mismatch');
    expect(reasonOf(() => orderAmountFromFunding(buy, { satoshis: 12_000n }, 10_000n))).toBe(
      'amount_below_minimum',
    );
    const sell = sellParams();
    expect(
      orderAmountFromFunding(sell, { satoshis: 2000n, token: { category: CATEGORY, amount: 5n } }, 1n),
    ).toBe(5n);
    expect(
      reasonOf(() =>
        orderAmountFromFunding(sell, { satoshis: 2001n, token: { category: CATEGORY, amount: 5n } }, 1n),
      ),
    ).toBe('funding_mismatch');
    expect(
      reasonOf(() =>
        orderAmountFromFunding(
          sell,
          { satoshis: 2000n, token: { category: OTHER_CATEGORY, amount: 5n } },
          1n,
        ),
      ),
    ).toBe('funding_mismatch');
    expect(
      reasonOf(() =>
        orderAmountFromFunding(
          sell,
          {
            satoshis: 2000n,
            token: { category: CATEGORY, amount: 5n, nft: { capability: 'none', commitment: '' } },
          },
          1n,
        ),
      ),
    ).toBe('funding_mismatch');
    expect(reasonOf(() => orderAmountFromFunding(sell, { satoshis: 2000n }, 1n))).toBe('funding_mismatch');
  });
});

describe('contract instantiation and addresses', () => {
  it.each(['mainnet', 'chipnet'] as const)(
    'derives the same P2SH32 address as CashScript on %s',
    (network) => {
      for (const params of [
        buyParams(),
        sellParams({ recipientLockingBytecode: P2SH32_RECIPIENT, minOut: 123_456_789n }),
      ]) {
        const { contract } = instantiateOrder(params, new ElectrumNetworkProvider(network));
        const derived = orderAddresses(params, network);
        expect(derived.address).toBe(contract.address);
        expect(derived.tokenAddress).toBe(contract.tokenAddress);
        expect(binToHex(derived.lockingBytecode)).toBe(contract.lockingBytecode);
        expect(binToHex(orderRedeemScript(params))).toBe(contract.bytecode);
        expect(derived.lockingBytecode.length).toBe(35);
      }
    },
  );

  it('picks the artifact by side and changes the address with every parameter', () => {
    const provider = new MockNetworkProvider();
    expect(instantiateOrder(buyParams(), provider).contract.name).toBe('AtPriceBuy');
    expect(instantiateOrder(sellParams(), provider).contract.name).toBe('AtPriceSell');
    const base = orderAddresses(buyParams(), 'chipnet').address;
    const variants = [
      buyParams({ minOut: 2n }),
      buyParams({ maxNetworkFee: 2001n }),
      buyParams({ nonce: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]) }),
      buyParams({ recipientLockingBytecode: P2SH32_RECIPIENT }),
      buyParams({ tokenCategory: OTHER_CATEGORY }),
      { ...sellParams(), minOut: 1n },
    ];
    for (const params of variants) expect(orderAddresses(params, 'chipnet').address).not.toBe(base);
  });
});
