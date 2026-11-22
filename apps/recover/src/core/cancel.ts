import type { ChainUtxo } from '@atprice/chain';
import {
  buildCancelTransaction,
  buildCancelWithSigTransaction,
  bytesEqual,
  classifyOrderSpend,
  decodeTransactionHex,
  finalizeWalletSignedTransaction,
  instantiateOrder,
  MIN_RELAY_FEE_PER_BYTE,
  OwnerUtxoRequiredError,
  TransactionVerificationError,
  type OwnerUtxoShortfall,
  type SignedTransaction,
  type UnsignedTransactionDraft,
} from '@atprice/core';
import { encodeLockingBytecodeP2pkh, type Output, type TransactionCommon } from '@bitauth/libauth';
import type { NetworkProvider } from 'cashscript';
import { placeholderSigningWallet } from '../../../web/lib/wallet/placeholder-wallets';
import { heldValue, type HeldValue, type LoadedOrder, type Outpoint } from './lookup';
import { toCashScriptUtxo } from './provider';

/** Matches the `wallet_name` a wallet sends in `wallet_ready` against the list the web cancel uses. */
export const supportsPlaceholderSigning = (walletName: string | null): boolean =>
  placeholderSigningWallet(walletName) !== null;

/**
 * `packages/chain` exposes no `blockchain.estimatefee`, so the rate is the network's minimum relay fee,
 * which is also the floor recover.md puts under any estimate. It is shown with the fee.
 */
export const FEE_PER_BYTE = MIN_RELAY_FEE_PER_BYTE;

/** architecture.md "Recovery": ask for at least 1,500 sat, and never less than core's requirement. */
export const OWNER_TOP_UP_FLOOR = 1_500n;

export type CancelPath = 'cancel' | 'cancelWithSig';

export interface BuiltCancel {
  readonly path: CancelPath;
  readonly draft: UnsignedTransactionDraft;
  /** The owner coin `cancel()` spends at input 0 and returns at output 0; null for `cancelWithSig`. */
  readonly ownerCoin: (HeldValue & Outpoint) | null;
  /** What the refund output pays the owner. */
  readonly refund: HeldValue;
  readonly fee: bigint;
  readonly feePerByte: bigint;
  readonly size: number;
}

export type CancelPlan =
  | { readonly kind: 'ready'; readonly cancel: BuiltCancel }
  | {
      readonly kind: 'no_owner_utxo';
      readonly reason: OwnerUtxoShortfall;
      /** What core says one payment must reach. */
      readonly requiredSatoshis: bigint;
      /** What the page asks for: core's figure rounded up to the 1,500 sat floor. */
      readonly askSatoshis: bigint;
      readonly largestSatoshis: bigint;
    }
  | { readonly kind: 'invalid'; readonly rule: string };

/** A failed rule R or signed-transaction check (cancel-confirmation.md "Local verification"). */
export class CancelCheckError extends Error {
  constructor(readonly rule: string) {
    super(`the cancel failed a safety check: ${rule}`);
    this.name = 'CancelCheckError';
  }
}

export const cancelBuildInvalidMessage = (rule: string, where: 'browser' | 'terminal'): string =>
  `The cancel built in your ${where === 'browser' ? 'browser' : 'terminal'} failed a safety check (${rule}). Nothing was sent to your wallet. Code: CANCEL_BUILD_INVALID.`;

const spentOrder = (order: LoadedOrder) => {
  const token = order.fundingOutput.token;
  return {
    satoshis: order.fundingOutput.satoshis,
    ...(token && {
      token: { category: token.category, amount: token.amount, ...(token.nft && { nft: token.nft }) },
    }),
  };
};

/**
 * Refund rule R from contract.md, plus the per-path shape rules, checked on a built or signed cancel.
 * Rule R itself is `classifyOrderSpend` in `packages/core`, so the check is the indexer's own.
 */
export const verifyCancel = (
  transaction: TransactionCommon,
  sourceOutputs: readonly Output[],
  order: LoadedOrder,
  path: CancelPath,
  ownerCoin: HeldValue | null,
): void => {
  const ownerLocking = encodeLockingBytecodeP2pkh(order.record.ownerPkh);
  const orderInput = path === 'cancel' ? 1 : 0;
  const spend = classifyOrderSpend(transaction, orderInput, order.record, spentOrder(order));
  if (spend.path !== 'cancel' || spend.authorization !== path) {
    throw new CancelCheckError(
      `refund rule R: output ${orderInput} must return the order's tokens to the owner with at least its value minus the fee cap`,
    );
  }
  if (path === 'cancel') {
    const source = sourceOutputs[0];
    if (source === undefined || !bytesEqual(source.lockingBytecode, ownerLocking) || source.token !== undefined) {
      throw new CancelCheckError('input 0 must be a coin without tokens at the owner address');
    }
    const change = transaction.outputs[0];
    if (
      change === undefined ||
      ownerCoin === null ||
      !bytesEqual(change.lockingBytecode, ownerLocking) ||
      change.valueSatoshis !== ownerCoin.satoshis ||
      change.token !== undefined
    ) {
      throw new CancelCheckError('output 0 must return the owner coin to the owner address unchanged');
    }
    if (transaction.outputs.length > transaction.inputs.length) {
      throw new CancelCheckError('cancel() may have at most as many outputs as inputs');
    }
  } else if (transaction.outputs.length > transaction.inputs.length + 1) {
    throw new CancelCheckError('cancelWithSig may have at most one more output than inputs');
  }
};

/**
 * Builds the cancel with `packages/core` (cancel-confirmation.md "The transaction this dialog builds"):
 * `cancel()` from the owner coins found on the chosen server, or `cancelWithSig` when asked for. A
 * missing owner coin is the `NO_OWNER_UTXO` state, never an error.
 */
export const planCancel = (options: {
  readonly order: LoadedOrder;
  readonly ownerUtxos: readonly ChainUtxo[];
  readonly path: CancelPath;
  readonly provider: NetworkProvider;
}): CancelPlan => {
  const { order, path } = options;
  if (order.status.kind !== 'unspent') return { kind: 'invalid', rule: 'the order output is already spent' };
  const contract = instantiateOrder(order.record, options.provider);
  const orders = [{ order: contract, utxo: toCashScriptUtxo(order.status.utxo) }];
  let draft: UnsignedTransactionDraft;
  let ownerCoin: (HeldValue & Outpoint) | null = null;
  try {
    if (path === 'cancel') {
      const built = buildCancelTransaction({
        owner: { utxos: options.ownerUtxos.map(toCashScriptUtxo) },
        orders,
        feePerByte: FEE_PER_BYTE,
      });
      draft = built;
      ownerCoin = { txid: built.ownerUtxo.txid, vout: built.ownerUtxo.vout, satoshis: built.ownerUtxo.satoshis };
    } else {
      draft = buildCancelWithSigTransaction({ orders, feePerByte: FEE_PER_BYTE });
    }
  } catch (error) {
    if (error instanceof OwnerUtxoRequiredError) {
      return {
        kind: 'no_owner_utxo',
        reason: error.reason,
        requiredSatoshis: error.requiredSatoshis,
        askSatoshis: error.requiredSatoshis > OWNER_TOP_UP_FLOOR ? error.requiredSatoshis : OWNER_TOP_UP_FLOOR,
        largestSatoshis: error.largestSatoshis,
      };
    }
    return { kind: 'invalid', rule: error instanceof Error ? error.message : String(error) };
  }
  const transaction = decodeTransactionHex(draft.unsignedHex);
  try {
    verifyCancel(transaction, draft.sourceOutputs, order, path, ownerCoin);
  } catch (error) {
    if (error instanceof CancelCheckError) return { kind: 'invalid', rule: error.rule };
    throw error;
  }
  const refund = transaction.outputs[path === 'cancel' ? 1 : 0];
  if (refund === undefined) return { kind: 'invalid', rule: 'the cancel has no refund output' };
  return {
    kind: 'ready',
    cancel: {
      path,
      draft,
      ownerCoin,
      refund: heldValue(refund),
      fee: draft.fee,
      feePerByte: FEE_PER_BYTE,
      size: draft.estimatedSize,
    },
  };
};

/**
 * The mandatory check on every wallet response (core-api.md "WizardConnect"), then rule R again on
 * the signed bytes. Throws `CancelCheckError` with the failing rule.
 */
export const checkSignedCancel = (built: BuiltCancel, order: LoadedOrder, signedHex: string): SignedTransaction => {
  let signed: SignedTransaction;
  try {
    signed = finalizeWalletSignedTransaction(built.draft, signedHex);
  } catch (error) {
    if (error instanceof TransactionVerificationError) {
      throw new CancelCheckError(`the signed transaction failed verification (${error.reason}: ${error.message})`);
    }
    throw error;
  }
  verifyCancel(decodeTransactionHex(signed.hex), signed.sourceOutputs, order, built.path, built.ownerCoin);
  return signed;
};

/** `Copy unsigned tx`: the unsigned hex with its source outputs, in the relay-safe encoding. */
export const unsignedCancelJson = (built: BuiltCancel): string =>
  JSON.stringify(
    {
      path: built.path === 'cancel' ? 'cancel()' : 'cancelWithSig()',
      unsignedTransaction: built.draft.unsignedHex,
      sourceOutputs: built.draft.request.transaction.sourceOutputs,
      inputPaths: built.draft.request.inputPaths,
    },
    null,
    2,
  );
