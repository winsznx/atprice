import {
  bytesEqual,
  classifyOrderSpend,
  decodeOrderRecord,
  decodeTransactionHex,
  orderLockingBytecode,
  type OrderRecord,
  type SpentOrderOutput,
} from '@atprice/core';
import { binToHex, type TransactionCommon } from '@bitauth/libauth';
import type { EvidenceOrder } from '@/lib/api/schemas';
import { chainErrorCode, isChainError, type ChainAccess } from '@/lib/chain/types';
import { formatBlockHeight } from '@/lib/format';
import { receivedText, tokenSymbol } from '@/lib/orders/display';

const OP_RETURN = 0x6a;

export type SettlementKind = 'fill' | 'cancel';

export const settlementKind = (order: EvidenceOrder): SettlementKind =>
  order.settlement.kind === 'fill' ? 'fill' : 'cancel';

/** Evidence links name the order by its funding txid (DD 10.5); the API resolves it to the outpoint. */
export const orderPath = (order: Pick<EvidenceOrder, 'funding'>): string => `/orders/${order.funding.txid}`;

/** Card heading anchor so `?order={txid}` can scroll to and focus it. */
export const cardHeadingId = (order: Pick<EvidenceOrder, 'funding'>): string =>
  `evidence-${order.funding.txid}`;

/** `Buy PUSD on BCH / PUSD`. */
export const orderTitle = (order: Pick<EvidenceOrder, 'side' | 'tokenCategory'>): string => {
  const symbol = tokenSymbol(order.tokenCategory);
  return `${order.side === 'buy' ? 'Buy' : 'Sell'} ${symbol} on BCH / ${symbol}`;
};

const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const pad = (value: number): string => value.toString().padStart(2, '0');

/** `22 November 2026, 13:58` for accessible names; UTC (labelled) before hydration, local after. */
export const spokenDateTime = (iso: string, local: boolean): string => {
  const date = new Date(iso);
  const day = local ? date.getDate() : date.getUTCDate();
  const month = LONG_MONTHS[local ? date.getMonth() : date.getUTCMonth()] ?? '';
  const year = local ? date.getFullYear() : date.getUTCFullYear();
  const hours = local ? date.getHours() : date.getUTCHours();
  const minutes = local ? date.getMinutes() : date.getUTCMinutes();
  return `${day} ${month} ${year}, ${pad(hours)}:${pad(minutes)}${local ? '' : ' UTC'}`;
};

export type VerifyResult =
  | {
      readonly kind: 'confirmed';
      readonly host: string;
      readonly settlement: SettlementKind;
      readonly blockHeight: number;
      readonly confirmations: number;
      /** Fill only: the payout and pool owner re-derived from the chain equal the listed ones. */
      readonly payoutAndPoolMatch: boolean;
    }
  | { readonly kind: 'mismatch'; readonly host: string; readonly differences: readonly string[] }
  | { readonly kind: 'unreachable'; readonly host: string; readonly code: string };

const UNKNOWN_HOST = 'the Electrum server';

const findRecord = (funding: TransactionCommon): OrderRecord | null => {
  for (const output of funding.outputs) {
    if (output.lockingBytecode[0] !== OP_RETURN) continue;
    try {
      return decodeOrderRecord(output.lockingBytecode);
    } catch (error) {
      // An OP_RETURN that isn't an ATPR record is allowed; only the absence of any record is a finding.
      console.debug('OP_RETURN output is not an ATPR record:', error);
    }
  }
  return null;
};

const spentOutput = (funding: TransactionCommon, vout: number): SpentOrderOutput | null => {
  const output = funding.outputs[vout];
  if (output === undefined) return null;
  return {
    satoshis: output.valueSatoshis,
    ...(output.token === undefined
      ? {}
      : {
          token: {
            category: binToHex(output.token.category),
            amount: output.token.amount,
            ...(output.token.nft === undefined
              ? {}
              : {
                  nft: {
                    capability: output.token.nft.capability,
                    commitment: binToHex(output.token.nft.commitment),
                  },
                }),
          },
        }),
  };
};

/** Compares the decoded ATPR record with the terms the API listed. */
const recordDifferences = (record: OrderRecord, order: EvidenceOrder): string[] => {
  const differences: string[] = [];
  if (record.side !== order.side)
    differences.push(`the record says ${record.side}, the list says ${order.side}`);
  if (record.tokenCategory !== order.tokenCategory)
    differences.push('the record names a different token category');
  if (record.minOut !== order.minOut)
    differences.push(`the record's minimum is ${record.minOut} base units, the list says ${order.minOut}`);
  if (record.maxNetworkFee !== order.maxNetworkFee)
    differences.push(
      `the record's network fee cap is ${record.maxNetworkFee} sat, the list says ${order.maxNetworkFee}`,
    );
  if (binToHex(record.ownerPkh) !== order.ownerPkh) differences.push('the record names a different owner');
  return differences;
};

/**
 * Re-checks one evidence row from the visitor's own browser (evidence.md "Browser-side verification"):
 * both transactions exist, the settlement's block and confirmations, and the order terms come from the
 * ATPR record in the funding transaction, not from AtPrice's server. For a fill, core's
 * `classifyOrderSpend` re-derives the payout and the pool owner from the settlement's own inputs and
 * outputs; for a cancel it confirms the cancel path. Every disagreement is listed, never hidden.
 */
export const verifyEvidenceOrder = async (
  chain: ChainAccess,
  order: EvidenceOrder,
): Promise<VerifyResult> => {
  const host = (): string => chain.endpointLabel ?? UNKNOWN_HOST;
  try {
    const [tip, fundingStatus, settlementStatus] = await Promise.all([
      chain.getTip(),
      chain.getTransactionStatus(order.funding.txid),
      chain.getTransactionStatus(order.settlement.txid),
    ]);
    const kind = settlementKind(order);
    const kindWord = kind === 'fill' ? 'fill' : 'cancel';
    const differences: string[] = [];

    let funding: TransactionCommon;
    let settlement: TransactionCommon;
    try {
      funding = decodeTransactionHex(fundingStatus.hex);
      settlement = decodeTransactionHex(settlementStatus.hex);
    } catch (error) {
      return {
        kind: 'mismatch',
        host: host(),
        differences: [
          `a transaction it returned does not decode (${error instanceof Error ? error.message : String(error)})`,
        ],
      };
    }

    if (fundingStatus.confirmations === 0) differences.push('the funding transaction is not confirmed');
    if (settlementStatus.confirmations === 0) differences.push(`the ${kindWord} is not confirmed`);
    const settlementHeight =
      settlementStatus.confirmations > 0 ? tip.height - settlementStatus.confirmations + 1 : null;
    if (settlementHeight !== null && settlementHeight !== order.settlementBlock.height) {
      differences.push(
        `the ${kindWord} is in block ${formatBlockHeight(settlementHeight)}, not ${formatBlockHeight(order.settlementBlock.height)}`,
      );
    }

    const record = findRecord(funding);
    const spent = spentOutput(funding, order.funding.vout);
    if (record === null) {
      differences.push('the funding transaction carries no ATPR order record');
    } else {
      differences.push(...recordDifferences(record, order));
      const orderOutput = funding.outputs[order.funding.vout];
      if (
        orderOutput === undefined ||
        !bytesEqual(orderOutput.lockingBytecode, orderLockingBytecode(record))
      ) {
        differences.push(`funding output ${order.funding.vout} is not the contract its record describes`);
      }
    }

    const inputIndex = settlement.inputs.findIndex(
      (input) =>
        binToHex(input.outpointTransactionHash) === order.funding.txid &&
        input.outpointIndex === order.funding.vout,
    );
    if (inputIndex === -1) differences.push(`the ${kindWord} does not spend this order's funding output`);

    let payoutAndPoolMatch = false;
    if (record !== null && spent !== null && inputIndex !== -1) {
      const spend = classifyOrderSpend(settlement, inputIndex, record, spent);
      if (order.settlement.kind === 'fill') {
        const fill = order.settlement;
        if (spend.path !== 'execute') {
          differences.push(
            spend.path === 'cancel'
              ? 'the chain shows a cancel, not a fill'
              : `the spend is not a valid fill (${spend.reason})`,
          );
        } else {
          if (spend.delivered !== fill.received) {
            differences.push(
              `the payout is ${receivedText(order, spend.delivered, 'exact')}, not ${receivedText(order, fill.received, 'exact')}`,
            );
          }
          if (spend.poolOwnerPkh !== fill.poolPkh) differences.push('the pool owner key hash differs');
          payoutAndPoolMatch = spend.delivered === fill.received && spend.poolOwnerPkh === fill.poolPkh;
        }
      } else if (spend.path !== 'cancel') {
        differences.push(
          spend.path === 'execute'
            ? 'the chain shows a fill, not a cancel'
            : `the spend is not a valid cancel (${spend.reason})`,
        );
      }
    }

    if (differences.length > 0 || settlementHeight === null) {
      return { kind: 'mismatch', host: host(), differences };
    }
    return {
      kind: 'confirmed',
      host: host(),
      settlement: kind,
      blockHeight: settlementHeight,
      confirmations: settlementStatus.confirmations,
      payoutAndPoolMatch,
    };
  } catch (error) {
    if (isChainError(error)) return { kind: 'unreachable', host: host(), code: chainErrorCode(error) };
    throw error;
  }
};

/** The line under a card after `Verify on chain` (evidence.md "States"). */
export const verifyResultText = (result: VerifyResult): string => {
  switch (result.kind) {
    case 'confirmed': {
      const confirmations = `${result.confirmations.toLocaleString('en-US')} ${result.confirmations === 1 ? 'confirmation' : 'confirmations'}`;
      const match =
        result.settlement === 'fill' && result.payoutAndPoolMatch ? ', payout and pool owner match' : '';
      return `Verified in your browser via ${result.host}: ${result.settlement} confirmed in block ${formatBlockHeight(result.blockHeight)}, ${confirmations}${match}.`;
    }
    case 'mismatch':
      return `${result.host} reports something different: ${result.differences.join('; ')}.`;
    case 'unreachable':
      return `Couldn't reach ${result.host} to verify. Try again or open the explorer link.`;
  }
};

export const EVIDENCE_PAGE_SIZE = 20;
/** `?order=` loads at most this many pages before saying the order isn't among completed orders. */
export const ORDER_SEARCH_MAX_PAGES = 5;

export type OrderSearch =
  | { readonly kind: 'none' }
  | { readonly kind: 'searching' }
  | { readonly kind: 'found'; readonly order: EvidenceOrder }
  | { readonly kind: 'not_found'; readonly txid: string };

/** Where the `?order={fundingTxid}` search stands, given the pages loaded so far. */
export const orderSearchState = (
  txid: string | null,
  pages: readonly { readonly orders: readonly EvidenceOrder[] }[],
  hasMore: boolean,
): OrderSearch => {
  if (txid === null) return { kind: 'none' };
  const normalized = txid.toLowerCase();
  for (const page of pages) {
    const order = page.orders.find((candidate) => candidate.funding.txid === normalized);
    if (order !== undefined) return { kind: 'found', order };
  }
  if (hasMore && pages.length < ORDER_SEARCH_MAX_PAGES) return { kind: 'searching' };
  return { kind: 'not_found', txid: normalized };
};
