import { binToHex, cashAddressToLockingBytecode, hexToBin, sha256 } from '@bitauth/libauth';
import { ChainError } from './errors.js';

/** Electrum script hash: sha256 of the locking bytecode, hex in reversed byte order. */
export const scripthashOf = (lockingBytecode: Uint8Array): string =>
  binToHex(sha256.hash(lockingBytecode).reverse());

export const lockingBytecodeOfAddress = (address: string): Uint8Array => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string')
    throw new ChainError('response_invalid', `invalid cash address: ${decoded}`);
  return decoded.bytecode;
};

/** Block hash (display order) of an 80-byte header given as hex. */
export const blockHashOfHeader = (headerHex: string): string =>
  binToHex(sha256.hash(sha256.hash(hexToBin(headerHex))).reverse());

/**
 * Rostrum's `utxo_hash`: single sha256 over the internal-order txid and the little-endian output index,
 * shown in reversed byte order like a txid (checked against a live chipnet subscription).
 */
export const rostrumUtxoHash = (txid: string, vout: number): string => {
  const bytes = new Uint8Array(36);
  bytes.set(hexToBin(txid).reverse(), 0);
  new DataView(bytes.buffer).setUint32(32, vout, true);
  return binToHex(sha256.hash(bytes).reverse());
};
