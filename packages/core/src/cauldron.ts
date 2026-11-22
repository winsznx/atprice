import { encodeLockingBytecodeP2sh32, flattenBinArray, hash256, hexToBin } from '@bitauth/libauth';
import type { Utxo } from 'cashscript';
import { bytesEqual } from './bytes.js';
import { InvalidPoolError } from './errors.js';

/** Cauldron V0 redeem script bytes before the 20-byte pool owner hash (`@cashlab/cauldron@1.0.3`). */
export const CAULDRON_V0_PREFIX: Uint8Array = hexToBin('746376a914');
/** Cauldron V0 redeem script bytes after the 20-byte pool owner hash. */
export const CAULDRON_V0_SUFFIX: Uint8Array = hexToBin(
  '88ac67c0d1c0ce88c25288c0cdc0c788c0c6c0d095c0c6c0cc9490539502e80396c0cc7c94c0d3957ca268',
);
export const CAULDRON_V0_REDEEM_SCRIPT_LENGTH = 68;
const OP_PUSHBYTES_68 = 0x44;

/** A Cauldron V0 pool UTXO. `token.category` is in display order, like every CashScript UTXO. */
export interface CauldronPoolUtxo extends Utxo {
  readonly token: { readonly amount: bigint; readonly category: string };
  readonly ownerPkh: Uint8Array;
}

const assertPkh = (pkh: Uint8Array): void => {
  if (pkh.length !== 20) {
    throw new InvalidPoolError('owner_pkh_length', `pool owner hash must be 20 bytes, got ${pkh.length}`);
  }
};

/** The 68-byte pool redeem script `PREFIX ‖ pkh ‖ SUFFIX`. */
export const poolRedeemScript = (pkh: Uint8Array): Uint8Array => {
  assertPkh(pkh);
  return flattenBinArray([CAULDRON_V0_PREFIX, pkh, CAULDRON_V0_SUFFIX]);
};

/** P2SH32 locking bytecode of the pool owned by `pkh`. */
export const poolLockingBytecode = (pkh: Uint8Array): Uint8Array =>
  encodeLockingBytecodeP2sh32(hash256(poolRedeemScript(pkh)));

/** The exchange-branch unlocking bytecode: a single push of the redeem script (69 bytes). */
export const poolUnlockingBytecode = (pkh: Uint8Array): Uint8Array =>
  flattenBinArray([Uint8Array.of(OP_PUSHBYTES_68), poolRedeemScript(pkh)]);

/** True when `lockingBytecode` is exactly the Cauldron V0 pool of `pkh`. */
export const isCauldronV0Pool = (lockingBytecode: Uint8Array, pkh: Uint8Array): boolean =>
  pkh.length === 20 && bytesEqual(lockingBytecode, poolLockingBytecode(pkh));
