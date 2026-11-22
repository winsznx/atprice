import type { ChainUtxo } from '@atprice/chain';
import type { Network } from '@atprice/core';
import { binToHex, cashAddressToLockingBytecode, hexToBin } from '@bitauth/libauth';
import type { NetworkProvider, SpendableUtxo, Utxo } from 'cashscript';
import type { RecoverChain } from './server';

/** A chain UTXO in CashScript's shape, without the Electrum height. */
export const toCashScriptUtxo = (utxo: ChainUtxo): Utxo => ({
  txid: utxo.txid,
  vout: utxo.vout,
  satoshis: utxo.satoshis,
  ...(utxo.token && {
    token: {
      category: utxo.token.category,
      amount: utxo.token.amount,
      ...(utxo.token.nft && { nft: { capability: utxo.token.nft.capability, commitment: utxo.token.nft.commitment } }),
    },
  }),
});

const spendable = (utxo: ChainUtxo, lockingBytecode: string): SpendableUtxo => ({
  ...toCashScriptUtxo(utxo),
  lockingBytecode,
});

/**
 * The CashScript provider `instantiateOrder` takes, backed by the user's chosen server. Core only
 * instantiates the contract with it; Recover broadcasts itself (`broadcastCancel`), never through here.
 */
export const recoverNetworkProvider = (chain: RecoverChain, network: Network): NetworkProvider => ({
  network,
  async getUtxos(address: string): Promise<SpendableUtxo[]> {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string') throw new TypeError(`Not a CashAddress: ${decoded}`);
    const hex = binToHex(decoded.bytecode);
    return (await chain.getUtxos(decoded.bytecode)).map((utxo) => spendable(utxo, hex));
  },
  async getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string): Promise<SpendableUtxo[]> {
    const bytes = typeof lockingBytecode === 'string' ? hexToBin(lockingBytecode) : lockingBytecode;
    const hex = binToHex(bytes);
    return (await chain.getUtxos(bytes)).map((utxo) => spendable(utxo, hex));
  },
  async getBlockHeight(): Promise<number> {
    return (await chain.getTip()).height;
  },
  getRawTransaction: (txid: string): Promise<string> => chain.getRawTransaction(txid),
  sendRawTransaction: (hex: string): Promise<string> => chain.broadcast(hex),
});
