import { binToHex, hexToBin } from '@bitauth/libauth';
import type { ChainUtxo, IndexerPool, RostrumPool } from '@atprice/chain';
import {
  isCauldronV0Pool,
  poolLockingBytecode,
  type CauldronPoolUtxo,
  type PoolReserves,
} from '@atprice/core';
import { outpointId } from '../orders/model.js';

/** A pool UTXO as Electrum reports it right now (mempool included), ready for core's builders. */
export interface LivePool extends CauldronPoolUtxo {
  readonly lockingBytecode: string;
  readonly outpoint: string;
  readonly ownerPkhHex: string;
  readonly reserves: PoolReserves;
  readonly confirmed: boolean;
}

/** Where pool candidates come from. Nominations only: reserves always come from a fresh Electrum read. */
export interface PoolNominator {
  nominate(tokenId: string): Promise<readonly { readonly ownerPkh: string; readonly outpoint: string }[]>;
}

export interface PoolUtxoReader {
  getUtxos(lockingBytecode: Uint8Array): Promise<ChainUtxo[]>;
}

export const nominationsFromIndexer = (
  rows: readonly IndexerPool[],
): { ownerPkh: string; outpoint: string }[] =>
  rows.map((row) => ({ ownerPkh: row.ownerPkh, outpoint: outpointId(row.txid, row.vout) }));

export const nominationsFromRostrum = (
  rows: readonly RostrumPool[],
): { ownerPkh: string; outpoint: string }[] =>
  rows.map((row) => ({ ownerPkh: row.ownerPkh, outpoint: outpointId(row.txid, row.vout) }));

export const livePoolFromUtxo = (
  ownerPkhHex: string,
  tokenId: string,
  utxo: ChainUtxo,
): LivePool | undefined => {
  const ownerPkh = hexToBin(ownerPkhHex);
  const token = utxo.token;
  if (
    token === undefined ||
    token.category !== tokenId ||
    token.nft !== undefined ||
    token.amount <= 0n ||
    utxo.satoshis <= 0n
  ) {
    return undefined;
  }
  const lockingBytecode = poolLockingBytecode(ownerPkh);
  if (!isCauldronV0Pool(lockingBytecode, ownerPkh)) return undefined;
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    satoshis: utxo.satoshis,
    token: { category: tokenId, amount: token.amount },
    ownerPkh,
    lockingBytecode: binToHex(lockingBytecode),
    outpoint: outpointId(utxo.txid, utxo.vout),
    ownerPkhHex,
    reserves: { sats: utxo.satoshis, tokens: token.amount },
    confirmed: utxo.height > 0,
  };
};

export interface PoolRead {
  readonly pools: readonly LivePool[];
  /** Nominated outpoints Electrum does not show, and live outpoints nobody nominated (cross-check). */
  readonly unconfirmedNominations: readonly string[];
  readonly unnominatedLive: readonly string[];
}

/** Reads every nominated pool owner's UTXOs from Electrum and keeps only genuine pools of the token. */
export const readLivePools = async (
  chain: PoolUtxoReader,
  tokenId: string,
  nominations: readonly { readonly ownerPkh: string; readonly outpoint: string }[],
): Promise<PoolRead> => {
  const owners = [...new Set(nominations.map((nomination) => nomination.ownerPkh))];
  const pools: LivePool[] = [];
  for (const owner of owners) {
    for (const utxo of await chain.getUtxos(poolLockingBytecode(hexToBin(owner)))) {
      const pool = livePoolFromUtxo(owner, tokenId, utxo);
      if (pool !== undefined) pools.push(pool);
    }
  }
  const live = new Set(pools.map((pool) => pool.outpoint));
  const nominated = new Set(nominations.map((nomination) => nomination.outpoint));
  return {
    pools,
    unconfirmedNominations: [...nominated].filter((outpoint) => !live.has(outpoint)),
    unnominatedLive: [...live].filter((outpoint) => !nominated.has(outpoint)),
  };
};
