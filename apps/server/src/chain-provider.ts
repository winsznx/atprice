import { binToHex, hexToBin } from '@bitauth/libauth';
import type { Network as CashScriptNetwork, NetworkProvider, SpendableUtxo } from 'cashscript';
import { lockingBytecodeOfAddress, type ChainHeader, type ChainUtxo } from '@atprice/chain';
import type { Network } from '@atprice/core';

/** The chain calls the provider makes; `ChainClient` satisfies it. */
export interface ProviderChain {
  getUtxos(lockingBytecode: Uint8Array): Promise<ChainUtxo[]>;
  getTip(): Promise<ChainHeader>;
  getRawTransaction(txid: string): Promise<string>;
  broadcast(hex: string): Promise<string>;
}

/**
 * CashScript's `NetworkProvider` over AtPrice's own Electrum client, so core can instantiate contracts
 * against the same failover connection the process already holds (CashScript's own Electrum provider
 * would open a second, unmonitored one).
 */
export class ChainNetworkProvider implements NetworkProvider {
  readonly network: CashScriptNetwork;

  constructor(
    private readonly chain: ProviderChain,
    network: Network,
  ) {
    this.network = network;
  }

  async getUtxos(address: string): Promise<SpendableUtxo[]> {
    return this.getUtxosForLockingBytecode(lockingBytecodeOfAddress(address));
  }

  async getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string): Promise<SpendableUtxo[]> {
    const bytes = typeof lockingBytecode === 'string' ? hexToBin(lockingBytecode) : lockingBytecode;
    const hex = binToHex(bytes);
    return (await this.chain.getUtxos(bytes)).map((utxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      lockingBytecode: hex,
      ...(utxo.token && {
        token: {
          category: utxo.token.category,
          amount: utxo.token.amount,
          ...(utxo.token.nft && {
            nft: { capability: utxo.token.nft.capability, commitment: utxo.token.nft.commitment },
          }),
        },
      }),
    }));
  }

  async getBlockHeight(): Promise<number> {
    return (await this.chain.getTip()).height;
  }

  async getRawTransaction(txid: string): Promise<string> {
    return this.chain.getRawTransaction(txid);
  }

  async sendRawTransaction(txHex: string): Promise<string> {
    return this.chain.broadcast(txHex);
  }
}
