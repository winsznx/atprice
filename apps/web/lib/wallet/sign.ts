import { BroadcastRejectedError } from '@atprice/chain';
import {
  finalizeWalletSignedTransaction,
  TransactionVerificationError,
  type SignedTransaction,
  type UnsignedTransactionDraft,
} from '@atprice/core';
import type { ChainAccess } from '../chain/types';
import type { WalletConnector } from './connector';
import { WalletError } from './errors';

/**
 * Wallet signature plus the mandatory check (core-api.md "WizardConnect"): every wallet response goes
 * through `finalizeWalletSignedTransaction` before anything can broadcast it.
 */
export const signDraft = async (
  connector: WalletConnector,
  draft: UnsignedTransactionDraft,
  signal?: AbortSignal,
): Promise<SignedTransaction> => {
  const signedHex = await connector.requestSignature(draft, signal);
  try {
    return finalizeWalletSignedTransaction(draft, signedHex);
  } catch (error) {
    if (error instanceof TransactionVerificationError) {
      throw new WalletError(
        'SIGNED_TX_MISMATCH',
        `The signed transaction failed AtPrice's check (${error.reason}).`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
};

export type BroadcastOutcome =
  | { readonly kind: 'accepted'; readonly txid: string }
  /** The node rejected it: nothing was spent. `detail` is the node's own text (notifications.md #11b). */
  | { readonly kind: 'rejected'; readonly detail: string }
  /** No answer: the transaction may or may not have reached the network (notifications.md #15). */
  | { readonly kind: 'unknown'; readonly txid: string; readonly detail: string };

/**
 * Broadcasts a verified transaction from the user's browser through Electrum (architecture.md step 4).
 * A server that answers with a different txid is treated as unknown, never as accepted.
 */
export const broadcastSigned = async (
  chain: ChainAccess,
  signed: SignedTransaction,
): Promise<BroadcastOutcome> => {
  try {
    const txid = await chain.broadcast(signed.hex);
    if (txid !== signed.txid) {
      return { kind: 'unknown', txid: signed.txid, detail: `the server answered with txid ${txid}` };
    }
    return { kind: 'accepted', txid };
  } catch (error) {
    if (error instanceof BroadcastRejectedError) {
      return { kind: 'rejected', detail: error.detail };
    }
    return {
      kind: 'unknown',
      txid: signed.txid,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};
