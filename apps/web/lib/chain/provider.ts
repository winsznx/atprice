import { binToHex, cashAddressToLockingBytecode, hexToBin } from '@bitauth/libauth';
import type { NetworkProvider, SpendableUtxo } from 'cashscript';
import type { NetworkConfig } from '../network';
import { ChainError, type ChainAccess, type ChainUtxo } from './types';

const toSpendable = (utxo: ChainUtxo, lockingBytecode: string): SpendableUtxo => ({
  txid: utxo.txid,
  vout: utxo.vout,
  satoshis: utxo.satoshis,
  lockingBytecode,
  ...(utxo.token && {
    token: {
      category: utxo.token.category,
      amount: utxo.token.amount,
      ...(utxo.token.nft && {
        nft: { capability: utxo.token.nft.capability, commitment: utxo.token.nft.commitment },
      }),
    },
  }),
});

/**
 * The CashScript provider `@atprice/core` builders take (`buildFundingTransaction`, `instantiateOrder`),
 * backed by the browser's own Electrum connection. Core only instantiates contracts with it; the web
 * app broadcasts through `lib/wallet/sign.ts`, never through this provider.
 */
export const chainNetworkProvider = (chain: ChainAccess, config: NetworkConfig): NetworkProvider => ({
  network: config.network,
  async getUtxos(address: string): Promise<SpendableUtxo[]> {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string') throw new ChainError('request_failed', `Not a CashAddress: ${decoded}`);
    const lockingBytecode = binToHex(decoded.bytecode);
    return (await chain.getUtxos(decoded.bytecode)).map((utxo) => toSpendable(utxo, lockingBytecode));
  },
  async getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string): Promise<SpendableUtxo[]> {
    const bytes = typeof lockingBytecode === 'string' ? hexToBin(lockingBytecode) : lockingBytecode;
    const hex = binToHex(bytes);
    return (await chain.getUtxos(bytes)).map((utxo) => toSpendable(utxo, hex));
  },
  async getBlockHeight(): Promise<number> {
    return (await chain.getTip()).height;
  },
  getRawTransaction: (txid: string): Promise<string> => chain.getRawTransaction(txid),
  sendRawTransaction: (hex: string): Promise<string> => chain.broadcast(hex),
});
