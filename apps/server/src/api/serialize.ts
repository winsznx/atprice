import { hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { explorerLinks } from '@atprice/chain';
import { isTerminalStatus, type Network } from '@atprice/core';
import { CASH_PREFIX, type OrderRow } from '../orders/model.js';

export const addressOfLocking = (
  lockingHex: string,
  network: Network,
  tokenSupport = false,
): string | null => {
  const encoded = lockingBytecodeToCashAddress({
    bytecode: hexToBin(lockingHex),
    prefix: CASH_PREFIX[network],
    tokenSupport,
  });
  return typeof encoded === 'string' ? null : encoded.address;
};

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const txRef = (network: Network, txid: string | null, height: number | null, blockHash: string | null) =>
  txid === null
    ? null
    : {
        txid,
        confirmed: height !== null,
        blockHeight: height,
        blockHash,
        explorerUrl: explorerLinks(network).transaction(txid),
      };

/** The public JSON of an order instance. Amounts are decimal strings (PRD 13.1). */
export const orderJson = (row: OrderRow) => ({
  id: row.id,
  network: row.network,
  instanceKind: row.instance_kind,
  parentOrderId: row.parent_order_id,
  status: row.status,
  terminal: isTerminalStatus(row.status),
  supported: row.supported,
  unsupportedReason: row.unsupported_reason,
  side: row.side,
  tokenId: row.token_id,
  ownerAddress: row.owner_address,
  ownerPkh: row.owner_pkh,
  orderAddress: row.order_address,
  orderAddressExplorerUrl: explorerLinks(row.network).address(row.order_address),
  recipientAddress: addressOfLocking(row.recipient_locking_bytecode, row.network, row.side === 'buy'),
  recipientLockingBytecode: row.recipient_locking_bytecode,
  minOut: row.min_out,
  maxNetworkFee: row.max_network_fee,
  nonce: row.nonce,
  contractVersion: row.contract_version,
  inputAmount: row.input_amount,
  satoshis: row.satoshis,
  tokenAmount: row.token_amount,
  funding: {
    vout: row.funding_vout,
    ...txRef(row.network, row.funding_txid, row.funding_height, row.funding_block_hash),
  },
  spend:
    row.spend_txid === null
      ? null
      : {
          kind: row.spend_kind,
          ...txRef(row.network, row.spend_txid, row.spend_height, row.spend_block_hash),
        },
  lastEvaluation: row.last_evaluation,
  lastEvaluatedAt: iso(row.last_evaluated_at),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export interface ExecutionRow {
  readonly id: string;
  readonly order_id: string;
  readonly network: Network;
  readonly txid: string;
  readonly side: 'buy' | 'sell';
  readonly input_amount: string;
  readonly output_amount: string;
  readonly surplus: string;
  readonly execution_fee: string;
  readonly network_fee: string;
  readonly payout_satoshis: string;
  readonly route_metadata: Record<string, unknown>;
  readonly by_atprice_keeper: boolean;
  readonly status: string;
  readonly block_height: number | null;
  readonly block_hash: string | null;
  readonly created_at: Date;
  readonly confirmed_at: Date | null;
}

export const executionJson = (row: ExecutionRow) => ({
  id: row.id,
  orderId: row.order_id,
  network: row.network,
  txid: row.txid,
  explorerUrl: explorerLinks(row.network).transaction(row.txid),
  side: row.side,
  inputAmount: row.input_amount,
  outputAmount: row.output_amount,
  surplus: row.surplus,
  executionFee: row.execution_fee,
  networkFee: row.network_fee,
  payoutSatoshis: row.payout_satoshis,
  route: row.route_metadata,
  byAtPriceKeeper: row.by_atprice_keeper,
  status: row.status,
  blockHeight: row.block_height,
  blockHash: row.block_hash,
  createdAt: row.created_at.toISOString(),
  confirmedAt: iso(row.confirmed_at),
});

export interface AttemptRow {
  readonly id: string;
  readonly order_id: string;
  readonly pool_outpoint: string | null;
  readonly pool_owner_pkh: string | null;
  readonly chained_from: string | null;
  readonly candidate: Record<string, unknown>;
  readonly quote_age_ms: number;
  readonly outcome: string;
  readonly failure_reason: string | null;
  readonly txid: string | null;
  readonly broadcast_results: unknown;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly duration_ms: number | null;
  readonly retry_after: Date | null;
}

export const attemptJson = (row: AttemptRow, network: Network) => ({
  id: row.id,
  orderId: row.order_id,
  outcome: row.outcome,
  failureReason: row.failure_reason,
  txid: row.txid,
  explorerUrl: row.txid === null ? null : explorerLinks(network).transaction(row.txid),
  poolOutpoint: row.pool_outpoint,
  poolOwnerPkh: row.pool_owner_pkh,
  chainedFrom: row.chained_from,
  candidate: row.candidate,
  quoteAgeMs: row.quote_age_ms,
  broadcastResults: row.broadcast_results,
  startedAt: row.started_at.toISOString(),
  finishedAt: iso(row.finished_at),
  durationMs: row.duration_ms,
  retryAfter: iso(row.retry_after),
});
