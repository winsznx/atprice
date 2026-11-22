import { binToHex, hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import {
  orderAddresses,
  orderArtifact,
  ownerLockingBytecode,
  type Network,
  type OrderParams,
  type OrderSide,
  type OrderStatus,
} from '@atprice/core';
import type { ChainToken } from '@atprice/chain';

/** An `orders` row as the server reads it. Amount columns arrive from pg as decimal strings. */
export interface OrderRow {
  readonly id: string;
  readonly network: Network;
  readonly instance_kind: 'funding' | 'stray';
  readonly parent_order_id: string | null;
  readonly funding_txid: string;
  readonly funding_vout: number;
  readonly side: OrderSide;
  readonly owner_pkh: string;
  readonly owner_address: string;
  readonly recipient_locking_bytecode: string;
  readonly token_id: string;
  readonly min_out: string;
  readonly max_network_fee: string;
  readonly nonce: string;
  readonly contract_version: string;
  readonly order_address: string;
  readonly order_locking_bytecode: string;
  readonly satoshis: string;
  readonly token_amount: string;
  readonly token_nft: { capability: 'none' | 'mutable' | 'minting'; commitment: string } | null;
  readonly input_amount: string | null;
  readonly supported: boolean;
  readonly unsupported_reason: string | null;
  readonly unsupported_detail: string | null;
  readonly status: OrderStatus;
  readonly funding_height: number | null;
  readonly funding_block_hash: string | null;
  readonly spend_txid: string | null;
  readonly spend_kind: 'execute' | 'cancel' | 'unknown' | null;
  readonly spend_height: number | null;
  readonly spend_block_hash: string | null;
  readonly vanish_sweeps: number;
  readonly claimed_by: string | null;
  readonly claimed_until: Date | null;
  readonly keeper_executable_since: Date | null;
  readonly last_evaluated_at: Date | null;
  readonly last_evaluation: KeeperEvaluation | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** What the keeper stores per order evaluation, compared by the independent evaluator (health). */
export interface KeeperEvaluation {
  readonly poolOutpoint: string | null;
  readonly poolOwnerPkh: string | null;
  /** Pinned supply, decimal string. */
  readonly supply: string;
  /** Pool output for that supply, decimal string; null when no pool could be quoted. */
  readonly output: string | null;
  readonly recipientAmount: string | null;
  readonly executable: boolean;
  readonly evaluatedAt: string;
}

export const outpointId = (txid: string, vout: number): string => `${txid}:${vout}`;

export const parseOutpoint = (id: string): { txid: string; vout: number } | undefined => {
  const match = /^([0-9a-f]{64}):(\d{1,6})$/.exec(id);
  if (match === null) return undefined;
  return { txid: match[1] ?? '', vout: Number(match[2]) };
};

export const paramsFromRow = (row: OrderRow): OrderParams => ({
  side: row.side,
  ownerPkh: hexToBin(row.owner_pkh),
  recipientLockingBytecode: hexToBin(row.recipient_locking_bytecode),
  tokenCategory: row.token_id,
  minOut: BigInt(row.min_out),
  maxNetworkFee: BigInt(row.max_network_fee),
  nonce: hexToBin(row.nonce),
});

export const ownerAddress = (ownerPkh: Uint8Array, network: Network): string => {
  const encoded = lockingBytecodeToCashAddress({
    bytecode: ownerLockingBytecode(ownerPkh),
    prefix: CASH_PREFIX[network],
  });
  if (typeof encoded === 'string') throw new Error(`owner address: ${encoded}`);
  return encoded.address;
};

export const CASH_PREFIX: Readonly<Record<Network, 'bitcoincash' | 'bchtest'>> = {
  mainnet: 'bitcoincash',
  chipnet: 'bchtest',
};

export const contractVersion = (side: OrderSide): string => `v1:${orderArtifact(side).fingerprint}`;

/** The instance data an observation inserts when it creates an order row. */
export interface OrderInstance {
  readonly id: string;
  readonly network: Network;
  readonly instanceKind: 'funding' | 'stray';
  readonly parentOrderId: string | null;
  readonly txid: string;
  readonly vout: number;
  readonly params: OrderParams;
  readonly satoshis: bigint;
  readonly token: ChainToken | undefined;
  readonly support:
    | { readonly supported: true; readonly amount: bigint }
    | { readonly supported: false; readonly reason: string; readonly detail: string };
}

export const instanceColumns = (
  instance: OrderInstance,
): Record<string, string | number | boolean | null> => {
  const { params } = instance;
  const addresses = orderAddresses(params, instance.network);
  return {
    id: instance.id,
    network: instance.network,
    instance_kind: instance.instanceKind,
    parent_order_id: instance.parentOrderId,
    funding_txid: instance.txid,
    funding_vout: instance.vout,
    side: params.side,
    owner_pkh: binToHex(params.ownerPkh),
    owner_address: ownerAddress(params.ownerPkh, instance.network),
    recipient_locking_bytecode: binToHex(params.recipientLockingBytecode),
    token_id: params.tokenCategory,
    min_out: params.minOut.toString(),
    max_network_fee: params.maxNetworkFee.toString(),
    nonce: binToHex(params.nonce),
    contract_version: contractVersion(params.side),
    order_address: params.side === 'sell' ? addresses.tokenAddress : addresses.address,
    order_locking_bytecode: binToHex(addresses.lockingBytecode),
    satoshis: instance.satoshis.toString(),
    token_amount: (instance.token?.amount ?? 0n).toString(),
    token_nft: instance.token?.nft === undefined ? null : JSON.stringify(instance.token.nft),
    input_amount: instance.support.supported ? instance.support.amount.toString() : null,
    supported: instance.support.supported,
    unsupported_reason: instance.support.supported ? null : instance.support.reason,
    unsupported_detail: instance.support.supported ? null : instance.support.detail,
  };
};

/** Order parameters as JSON (hex and decimal strings), the shape intents store and the API accepts. */
export interface OrderParamsJson {
  readonly side: OrderSide;
  readonly ownerPkh: string;
  readonly recipientLockingBytecode: string;
  readonly tokenCategory: string;
  readonly minOut: string;
  readonly maxNetworkFee: string;
  readonly nonce: string;
}

export const paramsToJson = (params: OrderParams): OrderParamsJson => ({
  side: params.side,
  ownerPkh: binToHex(params.ownerPkh),
  recipientLockingBytecode: binToHex(params.recipientLockingBytecode),
  tokenCategory: params.tokenCategory,
  minOut: params.minOut.toString(),
  maxNetworkFee: params.maxNetworkFee.toString(),
  nonce: binToHex(params.nonce),
});

export const paramsFromJson = (json: OrderParamsJson): OrderParams => ({
  side: json.side,
  ownerPkh: hexToBin(json.ownerPkh),
  recipientLockingBytecode: hexToBin(json.recipientLockingBytecode),
  tokenCategory: json.tokenCategory,
  minOut: BigInt(json.minOut),
  maxNetworkFee: BigInt(json.maxNetworkFee),
  nonce: hexToBin(json.nonce),
});
