import {
  binToHex,
  encodeLockingBytecodeP2pkh,
  encodeLockingBytecodeP2sh20,
  encodeLockingBytecodeP2sh32,
  hash160,
  secp256k1,
} from '@bitauth/libauth';
import { SignatureTemplate } from 'cashscript';
import type { OrderParams } from '../../src/index.js';

/** Non-palindromic categories (display order), so a byte-order mistake cannot pass by accident. */
export const CATEGORY = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fa0';
export const OTHER_CATEGORY = 'f0e0d0c0b0a090807060504030201000ffeeddccbbaa99887766554433221101';

export const privateKeyFrom = (seed: number): Uint8Array => {
  const key = new Uint8Array(32);
  key[31] = seed;
  key[0] = 0x11;
  if (!secp256k1.validatePrivateKey(key)) throw new Error('invalid fixture key');
  return key;
};

export interface KeyFixture {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly pkh: Uint8Array;
  readonly lockingBytecode: Uint8Array;
  readonly signer: SignatureTemplate;
}

export const keyFixture = (seed: number): KeyFixture => {
  const privateKey = privateKeyFrom(seed);
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  const pkh = hash160(publicKey);
  return {
    privateKey,
    publicKey,
    pkh,
    lockingBytecode: encodeLockingBytecodeP2pkh(pkh),
    signer: new SignatureTemplate(privateKey),
  };
};

export const OWNER = keyFixture(1);
export const STRANGER = keyFixture(2);
export const POOL_OWNER = keyFixture(3);

export const P2SH20_RECIPIENT = encodeLockingBytecodeP2sh20(hash160(Uint8Array.of(1, 2, 3)));
export const P2SH32_RECIPIENT = encodeLockingBytecodeP2sh32(new Uint8Array(32).fill(0x5a));

export const NONCE = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);

export const buyParams = (overrides: Partial<OrderParams> = {}): OrderParams => ({
  side: 'buy',
  ownerPkh: OWNER.pkh,
  recipientLockingBytecode: OWNER.lockingBytecode,
  tokenCategory: CATEGORY,
  minOut: 1n,
  maxNetworkFee: 2000n,
  nonce: NONCE,
  ...overrides,
});

export const sellParams = (overrides: Partial<OrderParams> = {}): OrderParams => ({
  ...buyParams(),
  side: 'sell',
  minOut: 2001n,
  ...overrides,
});

export const fakeTxid = (seed: number): string => binToHex(new Uint8Array(32).fill(seed));
