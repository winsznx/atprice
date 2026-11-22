import { binToHex, hexToBin } from '@bitauth/libauth';
import { buildPoolV0RedeemScriptBytecode, buildPoolV0UnlockingBytecode } from '@cashlab/cauldron';
import { describe, expect, it } from 'vitest';
import {
  CAULDRON_V0_PREFIX,
  CAULDRON_V0_REDEEM_SCRIPT_LENGTH,
  CAULDRON_V0_SUFFIX,
  InvalidPoolError,
  isCauldronV0Pool,
  poolLockingBytecode,
  poolRedeemScript,
  poolUnlockingBytecode,
} from '../src/index.js';
import { exchangeLab } from './support/cashlab.js';
import { POOL_OWNER, STRANGER } from './support/fixtures.js';
import { Random } from './support/random.js';

describe('Cauldron V0 pool template', () => {
  it('matches the chipnet pool verified on chain (research/cauldron.md 1.2)', () => {
    const pkh = hexToBin('a10dd0bc10a32b9ce10c8285a8bcaf586d00a140');
    expect(binToHex(poolLockingBytecode(pkh))).toBe(
      'aa20e5a8f7002215f734e98d55cb44253f9cf02870849739099936183e17caea80c887',
    );
  });

  it('is byte-identical to the @cashlab/cauldron template for random owner hashes', () => {
    const random = new Random(0xca1dn);
    for (let index = 0; index < 200; index += 1) {
      const pkh = random.bytes(20);
      const parameters = { withdraw_pubkey_hash: pkh };
      expect(poolRedeemScript(pkh)).toEqual(buildPoolV0RedeemScriptBytecode(parameters));
      expect(poolUnlockingBytecode(pkh)).toEqual(buildPoolV0UnlockingBytecode(parameters));
      expect(poolLockingBytecode(pkh)).toEqual(exchangeLab.generatePoolV0LockingBytecode(parameters));
    }
  });

  it('lays out PREFIX ‖ pkh ‖ SUFFIX in 68 bytes and unlocks with a single 69-byte push', () => {
    const script = poolRedeemScript(POOL_OWNER.pkh);
    expect(script.length).toBe(CAULDRON_V0_REDEEM_SCRIPT_LENGTH);
    expect(script.slice(0, 5)).toEqual(CAULDRON_V0_PREFIX);
    expect(script.slice(5, 25)).toEqual(POOL_OWNER.pkh);
    expect(script.slice(25)).toEqual(CAULDRON_V0_SUFFIX);
    const unlocking = poolUnlockingBytecode(POOL_OWNER.pkh);
    expect(unlocking.length).toBe(69);
    expect(unlocking[0]).toBe(0x44);
  });

  it('recognises only the pool of the given owner', () => {
    const locking = poolLockingBytecode(POOL_OWNER.pkh);
    expect(isCauldronV0Pool(locking, POOL_OWNER.pkh)).toBe(true);
    expect(isCauldronV0Pool(locking, STRANGER.pkh)).toBe(false);
    expect(isCauldronV0Pool(STRANGER.lockingBytecode, POOL_OWNER.pkh)).toBe(false);
    expect(isCauldronV0Pool(locking, POOL_OWNER.pkh.slice(1))).toBe(false);
    expect(() => poolRedeemScript(new Uint8Array(19))).toThrow(InvalidPoolError);
  });
});
