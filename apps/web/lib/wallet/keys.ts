import { binToHex, decodeHdPublicKey, encodeCashAddress } from '@bitauth/libauth';
import { ownerPkhFromPublicKey } from '@atprice/core';
import type { NetworkConfig } from '../network';

export type XpubNetwork = 'mainnet' | 'testnet';

export class XpubDecodeError extends Error {
  readonly code = 'WALLET_XPUB_INVALID';

  constructor(detail: string) {
    super(`WALLET_XPUB_INVALID: the wallet's receive xpub could not be decoded (${detail})`);
    this.name = 'XpubDecodeError';
  }
}

/**
 * The network a wallet is on, read from its xpub version (`xpub` mainnet, `tpub` testnet). The protocol
 * has no network field and the dapp library discards `.network`, so AtPrice decodes it itself
 * (research/wizardconnect.md section 8).
 */
export const xpubNetwork = (xpub: string): XpubNetwork => {
  const decoded = decodeHdPublicKey(xpub);
  if (typeof decoded === 'string') throw new XpubDecodeError(decoded);
  return decoded.network;
};

/** `mainnet` app needs a `mainnet` xpub; `chipnet` app needs `testnet` (DD 7.8 "wrong network"). */
export const walletNetworkMatches = (xpub: string, config: NetworkConfig): boolean =>
  xpubNetwork(xpub) === config.xpubNetwork;

/** DD 7.8 copy: a `tpub` doesn't say whether it is chipnet or testnet4. */
export const walletNetworkLabel = (network: XpubNetwork): string =>
  network === 'mainnet' ? 'mainnet' : 'a test network';

export interface OwnerIdentity {
  readonly publicKey: Uint8Array;
  readonly ownerPkh: Uint8Array;
  readonly ownerPkhHex: string;
  /** P2PKH CashAddress of `receive/0`: the owner address sent to `GET /orders?address=`. */
  readonly address: string;
  /** The same key's token-aware form (`z…`), where a buy payout lands. */
  readonly tokenAddress: string;
}

const encode = (config: NetworkConfig, type: 'p2pkh' | 'p2pkhWithTokens', payload: Uint8Array): string =>
  encodeCashAddress({ prefix: config.cashAddressPrefix, type, payload }).address;

/** Derives the owner identity from the `receive/0` key. `ownerPkhFromPublicKey` rejects a non-curve key. */
export const ownerIdentity = (receive0: Uint8Array, config: NetworkConfig): OwnerIdentity => {
  const ownerPkh = ownerPkhFromPublicKey(receive0);
  return {
    publicKey: receive0,
    ownerPkh,
    ownerPkhHex: binToHex(ownerPkh),
    address: encode(config, 'p2pkh', ownerPkh),
    tokenAddress: encode(config, 'p2pkhWithTokens', ownerPkh),
  };
};
