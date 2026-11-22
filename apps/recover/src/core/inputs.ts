import type { ElectrumEndpoint } from '@atprice/chain';
import type { Network } from '@atprice/core';
import { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';
import { CASH_ADDRESS_PREFIX } from '../config';

export type Validated<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const TXID = /^[0-9a-f]{64}$/;

export const TXID_REASON = 'A transaction id is 64 characters, 0-9 and a-f.';

/** recover.md "Controls": the txid input. Upper-case hex is accepted and lower-cased. */
export const parseTxid = (input: string): Validated<string> => {
  const value = input.trim().toLowerCase();
  return TXID.test(value) ? { ok: true, value } : { ok: false, reason: TXID_REASON };
};

export const addressReason = (network: Network): string => `Enter a ${network} Bitcoin Cash address.`;

export interface OwnerAddress {
  /** The P2PKH CashAddress with prefix, as the owner address is shown everywhere else. */
  readonly address: string;
  readonly ownerPkh: Uint8Array;
}

/**
 * An owner address: P2PKH (plain or token-aware form, which pay the same key) on this file's network.
 * The prefix may be left out. Every AtPrice order is owned by a P2PKH key hash (contract.md).
 */
export const parseOwnerAddress = (input: string, network: Network): Validated<OwnerAddress> => {
  const prefix = CASH_ADDRESS_PREFIX[network];
  const trimmed = input.trim().toLowerCase();
  const withPrefix = trimmed.includes(':') ? trimmed : `${prefix}:${trimmed}`;
  const decoded = decodeCashAddress(withPrefix);
  if (typeof decoded === 'string' || decoded.prefix !== prefix) {
    return { ok: false, reason: addressReason(network) };
  }
  if (decoded.type !== 'p2pkh' && decoded.type !== 'p2pkhWithTokens') {
    return { ok: false, reason: addressReason(network) };
  }
  const address = encodeCashAddress({ prefix, type: 'p2pkh', payload: decoded.payload }).address;
  return { ok: true, value: { address, ownerPkh: decoded.payload } };
};

export const SERVER_REASON = 'Enter a server address starting with wss://.';

const HOST = /^[a-z0-9.-]+$/i;

/** A user-entered `wss://host[:port]` Electrum server. The port defaults to 443, as for any wss URL. */
export const parseServerUrl = (input: string): Validated<ElectrumEndpoint> => {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith('wss://')) return { ok: false, reason: SERVER_REASON };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: SERVER_REASON };
  }
  const port = url.port === '' ? 443 : Number(url.port);
  if (!HOST.test(url.hostname) || (url.pathname !== '/' && url.pathname !== '') || url.search !== '') {
    return { ok: false, reason: SERVER_REASON };
  }
  return { ok: true, value: { host: url.hostname, port, transport: 'wss' } };
};
