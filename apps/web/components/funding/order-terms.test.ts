import { binToHex, encodeCashAddress, hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { decodeOrderRecord, InvalidOrderParamsError, SUPPORTED_MARKETS } from '@atprice/core';
import { describe, expect, it } from 'vitest';
import { networkConfigFor } from '@/lib/network';
import { estimateFees, maxBuySpend, offlineProvider, previewFunding } from './fees';
import { deriveOrder, intentAddressMatches, intentRequest, newNonce, parseRecipient } from './order-terms';

const chipnet = networkConfigFor('chipnet');
const market = SUPPORTED_MARKETS.chipnet[0];
if (market === undefined) throw new Error('chipnet allowlist is empty');
const ownerPkh = hexToBin('11'.repeat(20));
const nonce = hexToBin('0102030405060708');

const address = (prefix: 'bchtest' | 'bitcoincash', type: 'p2pkh' | 'p2pkhWithTokens') =>
  encodeCashAddress({ prefix, type, payload: ownerPkh }).address;

describe('newNonce', () => {
  it('redraws an all-zero draw', () => {
    const draws = [new Uint8Array(8), Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 9)];
    const nonceValue = newNonce((bytes) => {
      bytes.set(draws.shift() ?? new Uint8Array(8));
      return bytes;
    });
    expect(binToHex(nonceValue)).toBe('0000000000000009');
  });
});

describe('parseRecipient', () => {
  it('accepts a token-aware address for a buy', () => {
    expect(parseRecipient(address('bchtest', 'p2pkhWithTokens'), 'buy', chipnet).kind).toBe('ok');
  });

  it('refuses a plain address for a buy, because tokens could be lost', () => {
    expect(parseRecipient(address('bchtest', 'p2pkh'), 'buy', chipnet)).toEqual({
      kind: 'invalid',
      message:
        'Tokens need a CashTokens-ready address (starts with bchtest:z). Sending tokens to other addresses can lose them.',
    });
  });

  it('accepts a plain address for a sell', () => {
    expect(parseRecipient(address('bchtest', 'p2pkh'), 'sell', chipnet).kind).toBe('ok');
  });

  it('names the other network', () => {
    expect(parseRecipient(address('bitcoincash', 'p2pkh'), 'sell', chipnet)).toEqual({
      kind: 'invalid',
      message: 'This address is for mainnet.',
    });
  });

  it('asks for an address when the text is not one', () => {
    expect(parseRecipient('hello', 'sell', chipnet)).toEqual({
      kind: 'invalid',
      message: 'Enter a Bitcoin Cash address.',
    });
  });
});

describe('deriveOrder', () => {
  const inputs = {
    side: 'buy' as const,
    tokenCategory: market.tokenCategory,
    amount: 50_000_000n,
    minOut: 23_000n,
    ownerPkh,
    recipientLockingBytecode: null,
  };

  it('defaults the recipient to the owner and encodes a record that decodes to the same terms', () => {
    const order = deriveOrder(inputs, 'chipnet', nonce);
    const record = decodeOrderRecord(order.record);
    expect({ ...record, ownerPkh: binToHex(record.ownerPkh), nonce: binToHex(record.nonce) }).toMatchObject({
      side: 'buy',
      minOut: 23_000n,
      maxNetworkFee: 2_000n,
      ownerPkh: '11'.repeat(20),
      nonce: '0102030405060708',
    });
  });

  it('refuses a token outside the allowlist', () => {
    expect(() => deriveOrder({ ...inputs, tokenCategory: 'ab'.repeat(32) }, 'chipnet', nonce)).toThrow(
      InvalidOrderParamsError,
    );
  });

  it('funds a sell to the token-aware address', () => {
    const order = deriveOrder(
      { ...inputs, side: 'sell', amount: 1_000n, minOut: 250_002_000n },
      'chipnet',
      nonce,
    );
    expect(order.orderAddress.startsWith('bchtest:r')).toBe(true);
  });

  it('serialises the intent with hex fields', () => {
    expect(intentRequest(deriveOrder(inputs, 'chipnet', nonce))).toMatchObject({
      ownerPkh: '11'.repeat(20),
      nonce: '0102030405060708',
      amount: 50_000_000n,
      minOut: 23_000n,
    });
  });

  it('sends the browser-derived contract address so the server can cross-check it', () => {
    // #given an order derived in the browser
    const order = deriveOrder(inputs, 'chipnet', nonce);
    // #when
    const request = intentRequest(order);
    // #then
    expect(request.orderAddress).toBe(order.orderAddress);
  });
});

describe('intentAddressMatches', () => {
  const order = deriveOrder(
    {
      side: 'buy',
      tokenCategory: market.tokenCategory,
      amount: 50_000_000n,
      minOut: 23_000n,
      ownerPkh,
      recipientLockingBytecode: null,
    },
    'chipnet',
    nonce,
  );

  it('matches either encoding of the same locking bytecode', () => {
    const tokenForm = lockingBytecodeToCashAddress({
      bytecode: order.orderLockingBytecode,
      prefix: 'bchtest',
      tokenSupport: true,
    });
    if (typeof tokenForm === 'string') throw new Error(tokenForm);
    expect([
      intentAddressMatches(order.orderAddress, order),
      intentAddressMatches(tokenForm.address, order),
    ]).toEqual([true, true]);
  });

  it('does not match a different contract (INTENT_MISMATCH)', () => {
    const other = deriveOrder(
      {
        side: 'buy',
        tokenCategory: market.tokenCategory,
        amount: 50_000_000n,
        minOut: 23_001n,
        ownerPkh,
        recipientLockingBytecode: null,
      },
      'chipnet',
      nonce,
    );
    expect(intentAddressMatches(other.orderAddress, order)).toBe(false);
  });
});

describe('fees through core builders', () => {
  it('estimates a funding and a cancel fee for a buy before any wallet is connected', () => {
    const estimate = estimateFees({
      side: 'buy',
      tokenCategory: market.tokenCategory,
      network: 'chipnet',
      feePerByte: 1n,
      ownerPkh: null,
      recipientLockingBytecode: null,
      amount: null,
      minOut: null,
      minimumAmount: market.minimumAmount.buy,
    });
    expect(estimate !== null && estimate.fundingFee > 0n && estimate.cancelFee > 0n).toBe(true);
  });

  it('caps the cancel estimate at maxNetworkFee', () => {
    const estimate = estimateFees({
      side: 'sell',
      tokenCategory: market.tokenCategory,
      network: 'chipnet',
      feePerByte: 1n,
      ownerPkh,
      recipientLockingBytecode: null,
      amount: 1_000n,
      minOut: null,
      minimumAmount: market.minimumAmount.sell,
    });
    expect(estimate !== null && estimate.cancelFee <= 2_000n).toBe(true);
  });

  it('reports a shortfall with core’s required and available figures', () => {
    const order = deriveOrder(
      {
        side: 'buy',
        tokenCategory: market.tokenCategory,
        amount: 50_000_000n,
        minOut: 23_000n,
        ownerPkh,
        recipientLockingBytecode: null,
      },
      'chipnet',
      nonce,
    );
    const preview = previewFunding({
      params: order.params,
      amount: 50_000_000n,
      minimumAmount: market.minimumAmount.buy,
      walletUtxos: [
        {
          txid: 'aa'.repeat(32),
          vout: 0,
          satoshis: 10_000n,
          lockingBytecode: `76a914${'11'.repeat(20)}88ac`,
          pathName: 'receive',
          addressIndex: 0,
        },
      ],
      feePerByte: 1n,
      network: 'chipnet',
      provider: offlineProvider('chipnet'),
    });
    expect(preview.kind === 'short' && preview.resource === 'bch' && preview.available === 10_000n).toBe(
      true,
    );
  });
});

describe('maxBuySpend', () => {
  it('steps down by core’s shortfall until the funding builds', () => {
    const fee = 400n;
    const spendable = 10_000_000n;
    const build = (spend: bigint): ReturnType<typeof previewFunding> => {
      const required = spend + 2_000n + 1_000n + fee + 1_000n;
      return required <= spendable
        ? ({ kind: 'ok' } as ReturnType<typeof previewFunding>)
        : { kind: 'short', resource: 'bch', required, available: spendable };
    };
    expect(maxBuySpend(build, spendable)).toBe(spendable - 2_000n - 1_000n - 1_000n - fee);
  });
});
