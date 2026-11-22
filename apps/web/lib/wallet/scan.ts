import { binToHex, encodeLockingBytecodeP2pkh, hash160 } from '@bitauth/libauth';
import type { WalletPathName, WalletUtxo } from '@atprice/core';
import type { ChainAccess } from '../chain/types';
import { GAP_LIMIT } from './constants';

export type PubkeyAt = (pathName: WalletPathName, index: number) => Uint8Array | undefined;

export interface TokenBalance {
  readonly category: string;
  readonly fungible: bigint;
  readonly nftCount: number;
}

export interface WalletScan {
  /** Every UTXO at the scanned addresses, each mapped to its `(path, index)` for `inputPaths`. */
  readonly utxos: readonly WalletUtxo[];
  /** Sum of token-free UTXOs: what the funding builder can pay satoshis from. */
  readonly bchSats: bigint;
  readonly tokens: readonly TokenBalance[];
  /** Addresses holding at least one UTXO (wallet.md `Balances (coins at {n} addresses)`). */
  readonly addressesWithCoins: number;
  readonly scannedAt: number;
}

const SCAN_PATHS: readonly WalletPathName[] = ['receive', 'change'];

const scanPath = async (
  chain: ChainAccess,
  pubkeyAt: PubkeyAt,
  pathName: WalletPathName,
): Promise<WalletUtxo[]> => {
  const found: WalletUtxo[] = [];
  let unused = 0;
  for (let index = 0; unused < GAP_LIMIT; index += 1) {
    const pubkey = pubkeyAt(pathName, index);
    if (pubkey === undefined) break;
    const lockingBytecode = encodeLockingBytecodeP2pkh(hash160(pubkey));
    const history = await chain.getHistory(lockingBytecode);
    if (history.length === 0) {
      unused += 1;
      continue;
    }
    unused = 0;
    const lockingHex = binToHex(lockingBytecode);
    for (const utxo of await chain.getUtxos(lockingBytecode)) {
      found.push({
        txid: utxo.txid,
        vout: utxo.vout,
        satoshis: utxo.satoshis,
        lockingBytecode: lockingHex,
        pathName,
        addressIndex: index,
        ...(utxo.token && { token: utxo.token }),
      });
    }
  }
  return found;
};

/**
 * Scans `receive` and `change` with a gap limit of 20 (wallet.md "Balances"). Trade's `Balance`, `Max`
 * and the funding builder all read this one result, so they can never disagree.
 */
export const scanWallet = async (chain: ChainAccess, pubkeyAt: PubkeyAt): Promise<WalletScan> => {
  const perPath = await Promise.all(SCAN_PATHS.map((pathName) => scanPath(chain, pubkeyAt, pathName)));
  const utxos = perPath.flat();
  const tokens = new Map<string, { fungible: bigint; nftCount: number }>();
  let bchSats = 0n;
  for (const utxo of utxos) {
    if (utxo.token === undefined) {
      bchSats += utxo.satoshis;
      continue;
    }
    const entry = tokens.get(utxo.token.category) ?? { fungible: 0n, nftCount: 0 };
    entry.fungible += utxo.token.amount;
    if (utxo.token.nft !== undefined) entry.nftCount += 1;
    tokens.set(utxo.token.category, entry);
  }
  const addresses = new Set(utxos.map((utxo) => `${utxo.pathName}/${utxo.addressIndex}`));
  return {
    utxos,
    bchSats,
    tokens: [...tokens.entries()].map(([category, entry]) => ({ category, ...entry })),
    addressesWithCoins: addresses.size,
    scannedAt: Date.now(),
  };
};
