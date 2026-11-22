import { binToHex } from '@bitauth/libauth';
import { MockNetworkProvider, type Utxo } from 'cashscript';
import {
  buildFundingTransaction,
  type FundingDraft,
  type OrderParams,
  type WalletUtxo,
} from '../../src/index.js';
import { fakeTxid, keyFixture, OWNER, type KeyFixture } from './fixtures.js';
import type { WalletKeys } from './wallet.js';

export const provider = new MockNetworkProvider();
export const CHANGE_KEY = keyFixture(10);
export const RECEIVE_5_KEY = keyFixture(11);
export const KEYS: WalletKeys = new Map([
  ['receive/0', OWNER.privateKey],
  ['change/3', CHANGE_KEY.privateKey],
  ['receive/5', RECEIVE_5_KEY.privateKey],
]);

let txidSeed = 0;
export const walletUtxo = (
  key: KeyFixture,
  pathName: WalletUtxo['pathName'],
  addressIndex: number,
  satoshis: bigint,
  token?: Utxo['token'],
): WalletUtxo => {
  txidSeed += 1;
  return {
    txid: fakeTxid(txidSeed),
    vout: 0,
    satoshis,
    lockingBytecode: binToHex(key.lockingBytecode),
    pathName,
    addressIndex,
    ...(token && { token }),
  };
};

export const fund = (
  params: OrderParams,
  amount: bigint,
  walletUtxos: readonly WalletUtxo[],
  minimumAmount = 1n,
): FundingDraft =>
  buildFundingTransaction({ params, amount, minimumAmount, walletUtxos, network: 'chipnet', provider });
