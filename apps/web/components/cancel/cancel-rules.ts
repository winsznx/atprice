import { binToHex, encodeTransactionOutput, type Output, type TransactionCommon } from '@bitauth/libauth';
import { decodeTransactionHex } from '@atprice/core';

/*
 * Refund rule R (contract.md "Cancel (both sides)", cancel-confirmation.md "Local verification"), run on
 * the cancel built in the browser and again on the one the wallet signs. A failure names the rule and
 * blocks with CANCEL_BUILD_INVALID; nothing reaches the wallet or the network.
 */

export type CancelPath = 'cancel' | 'cancelWithSig';

export interface CoinFacts {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: bigint;
  /** Category in display order, as CashScript and Electrum print it. */
  readonly token?: {
    readonly category: string;
    readonly amount: bigint;
    readonly nft?: { readonly capability: string; readonly commitment: string };
  };
}

export interface CancelRuleContext {
  readonly path: CancelPath;
  readonly ownerLockingBytecode: Uint8Array;
  readonly order: CoinFacts;
  readonly maxNetworkFee: bigint;
  /** The authorizing coin at input 0 (`cancel()` only). */
  readonly ownerCoin: CoinFacts | null;
}

export type CancelRule =
  | 'order_input_missing'
  | 'refund_missing'
  | 'refund_address'
  | 'refund_token'
  | 'refund_value'
  | 'owner_input'
  | 'owner_output_address'
  | 'owner_output_value'
  | 'owner_output_token'
  | 'output_count';

/** Plain words for each rule, printed in `({rule})` after the safety-check sentence. */
export const CANCEL_RULE_TEXT: Readonly<Record<CancelRule, string>> = {
  order_input_missing: 'the order output is not an input',
  refund_missing: 'there is no refund output for the order input',
  refund_address: 'the refund does not pay your owner address',
  refund_token: 'the refund does not carry the order’s tokens unchanged',
  refund_value: 'the refund is smaller than the order’s value minus its network fee cap',
  owner_input: 'input 0 is not the coin at your owner address',
  owner_output_address: 'output 0 does not return your coin to your owner address',
  owner_output_value: 'output 0 does not return your coin’s full value',
  owner_output_token: 'output 0 does not return your coin’s tokens unchanged',
  output_count: 'the transaction has more outputs than the rule allows',
};

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const spends = (transaction: TransactionCommon, coin: CoinFacts): number =>
  transaction.inputs.findIndex(
    (input) => binToHex(input.outpointTransactionHash) === coin.txid && input.outpointIndex === coin.vout,
  );

const tokenEqual = (output: Output, coin: CoinFacts): boolean => {
  const token = output.token;
  if (coin.token === undefined) return token === undefined;
  if (token === undefined) return false;
  if (binToHex(token.category) !== coin.token.category || token.amount !== coin.token.amount) return false;
  if (coin.token.nft === undefined) return token.nft === undefined;
  return (
    token.nft !== undefined &&
    token.nft.capability === coin.token.nft.capability &&
    binToHex(token.nft.commitment) === coin.token.nft.commitment
  );
};

/** The first rule the transaction breaks, or null when it passes rule R for its path. */
export const checkCancelRules = (transaction: TransactionCommon, context: CancelRuleContext): CancelRule | null => {
  const orderIndex = spends(transaction, context.order);
  if (orderIndex < 0) return 'order_input_missing';
  const refund = transaction.outputs[orderIndex];
  if (refund === undefined) return 'refund_missing';
  if (!bytesEqual(refund.lockingBytecode, context.ownerLockingBytecode)) return 'refund_address';
  if (!tokenEqual(refund, context.order)) return 'refund_token';
  if (refund.valueSatoshis < context.order.satoshis - context.maxNetworkFee) return 'refund_value';

  if (context.path === 'cancel') {
    const coin = context.ownerCoin;
    if (coin === null || spends(transaction, coin) !== 0) return 'owner_input';
    const change = transaction.outputs[0];
    if (change === undefined || !bytesEqual(change.lockingBytecode, context.ownerLockingBytecode)) {
      return 'owner_output_address';
    }
    if (change.valueSatoshis !== coin.satoshis) return 'owner_output_value';
    if (!tokenEqual(change, coin)) return 'owner_output_token';
    if (transaction.outputs.length > transaction.inputs.length) return 'output_count';
    return null;
  }
  if (transaction.outputs.length > transaction.inputs.length + 1) return 'output_count';
  return null;
};

export type SignedDifference = 'inputs' | 'outputs' | null;

/** The signed transaction must spend the same inputs and carry byte-identical outputs. */
export const signedDifference = (built: TransactionCommon, signed: TransactionCommon): SignedDifference => {
  const sameInputs =
    built.inputs.length === signed.inputs.length &&
    built.inputs.every((input, index) => {
      const other = signed.inputs[index];
      return (
        other !== undefined &&
        bytesEqual(input.outpointTransactionHash, other.outpointTransactionHash) &&
        input.outpointIndex === other.outpointIndex &&
        input.sequenceNumber === other.sequenceNumber
      );
    });
  if (!sameInputs) return 'inputs';
  const sameOutputs =
    built.outputs.length === signed.outputs.length &&
    built.outputs.every((output, index) => {
      const other = signed.outputs[index];
      return other !== undefined && bytesEqual(encodeTransactionOutput(output), encodeTransactionOutput(other));
    });
  return sameOutputs ? null : 'outputs';
};

/**
 * The cross-check against `POST /orders/:id/cancel/prepare` (architecture.md "API"). The browser is the
 * authority: whatever the server answers, only the cancel built and checked here is sent for signing,
 * so the answer is shown as a verification line and never blocks.
 */
export type ServerCheck =
  | { readonly kind: 'pending' }
  /** `cancelWithSig`: the endpoint builds only `cancel()`, so there is nothing to compare. */
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'same' }
  /** Same order input and byte-identical refund; the server chose another owner coin or fee. */
  | { readonly kind: 'same_refund' }
  | { readonly kind: 'different'; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly code: string };

export const compareWithServer = (
  localHex: string,
  serverHex: string,
  context: Pick<CancelRuleContext, 'order'>,
): ServerCheck => {
  if (localHex === serverHex) return { kind: 'same' };
  let local: TransactionCommon;
  let server: TransactionCommon;
  try {
    local = decodeTransactionHex(localHex);
    server = decodeTransactionHex(serverHex);
  } catch (error) {
    console.warn('Cancel comparison could not decode a transaction:', error);
    return { kind: 'different', detail: 'its transaction could not be decoded' };
  }
  const localIndex = spends(local, context.order);
  const serverIndex = spends(server, context.order);
  if (serverIndex < 0) return { kind: 'different', detail: 'it does not spend this order' };
  const localRefund = local.outputs[localIndex];
  const serverRefund = server.outputs[serverIndex];
  if (localRefund === undefined || serverRefund === undefined) {
    return { kind: 'different', detail: 'it has no refund output' };
  }
  return bytesEqual(encodeTransactionOutput(localRefund), encodeTransactionOutput(serverRefund))
    ? { kind: 'same_refund' }
    : { kind: 'different', detail: 'its refund differs' };
};

export const serverCheckText = (check: ServerCheck): string | null => {
  switch (check.kind) {
    case 'pending':
    case 'not_applicable':
      return null;
    case 'same':
      return 'Built in your browser. AtPrice’s server built the same cancel.';
    case 'same_refund':
      return 'Built in your browser. AtPrice’s server built the same refund with a different coin or fee.';
    case 'different':
      return `Built in your browser. AtPrice’s server built a different cancel (${check.detail}). Only the cancel built here goes to your wallet.`;
    case 'unavailable':
      return `Built in your browser. AtPrice’s server didn’t check this cancel (${check.code}).`;
  }
};

/** The refund output's index: `cancel()` refunds at 1 (after the owner coin), `cancelWithSig` at 0. */
export const refundIndex = (path: CancelPath): number => (path === 'cancel' ? 1 : 0);

/** The smallest payment the UI asks for: the builder's exact figure, rounded up to 1,500 sat. */
export const OWNER_TOP_UP_FLOOR = 1_500n;
export const topUpRequest = (requiredSatoshis: bigint): bigint =>
  requiredSatoshis > OWNER_TOP_UP_FLOOR ? requiredSatoshis : OWNER_TOP_UP_FLOOR;
