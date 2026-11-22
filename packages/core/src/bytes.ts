import { binToHex, hexToBin } from '@bitauth/libauth';

const CATEGORY_PATTERN = /^[0-9a-f]{64}$/;

/** True for a token category ID in display order: 64 lowercase hex characters. */
export const isTokenCategoryHex = (value: string): boolean => CATEGORY_PATTERN.test(value);

/**
 * Converts a category ID as shown by explorers, the Cauldron indexer and CashScript `token.category`
 * into the byte order the VM's introspection opcodes push (the contract's `bytes32 tokenCategory`).
 */
export const tokenCategoryToVmBytes = (categoryHex: string): Uint8Array => hexToBin(categoryHex).reverse();

/** Inverse of {@link tokenCategoryToVmBytes}. */
export const tokenCategoryFromVmBytes = (vmBytes: Uint8Array): string => binToHex(vmBytes.slice().reverse());

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);
