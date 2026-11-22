import { hexToBin } from '@bitauth/libauth';
import ExchangeLab from '@cashlab/cauldron/exchange-lab.js';
import type { PoolV0 } from '@cashlab/cauldron/types.js';
import type { PoolReserves } from '../../src/index.js';
import { fakeTxid } from './fixtures.js';

export const exchangeLab = new ExchangeLab();

/** A pool object exactly as cashlab builds it from an indexer row. */
export const cashlabPool = (ownerPkh: Uint8Array, category: string, reserves: PoolReserves): PoolV0 => {
  const parameters = { withdraw_pubkey_hash: ownerPkh };
  return {
    version: '0',
    parameters,
    outpoint: { txhash: hexToBin(fakeTxid(0x77)), index: 0 },
    output: {
      locking_bytecode: exchangeLab.generatePoolV0LockingBytecode(parameters),
      amount: reserves.sats,
      token: { amount: reserves.tokens, token_id: category },
    },
  };
};
