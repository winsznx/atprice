import { BroadcastRejectedError, isAlreadyKnownRejection, isSpentInputRejection } from '@atprice/chain';
import type { SignedTransaction } from '@atprice/core';
import { describeError } from './errors';
import type { RecoverChain } from './server';

/** recover.md "Broadcast unknown": a server that hasn't answered after 20 s gets the unknown state. */
export const BROADCAST_UNKNOWN_AFTER_MS = 20_000;

export type BroadcastOutcome =
  | { readonly kind: 'accepted'; readonly txid: string }
  /** The node's own text; `alreadySpent` means the order output was spent first (fill or cancel). */
  | { readonly kind: 'rejected'; readonly detail: string; readonly alreadySpent: boolean }
  /** No answer, or an answer that doesn't match: the cancel may or may not have reached the network. */
  | { readonly kind: 'unknown'; readonly txid: string; readonly detail: string };

const NO_ANSWER = Symbol('no answer');

/** Broadcasts a verified cancel on the user's chosen server, never through AtPrice. */
export const broadcastCancel = async (
  chain: RecoverChain,
  signed: SignedTransaction,
  timeoutMs: number = BROADCAST_UNKNOWN_AFTER_MS,
): Promise<BroadcastOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof NO_ANSWER>((resolve) => {
    timer = setTimeout(() => resolve(NO_ANSWER), timeoutMs);
  });
  try {
    const answer = await Promise.race([chain.broadcast(signed.hex), timeout]);
    if (answer === NO_ANSWER) {
      return { kind: 'unknown', txid: signed.txid, detail: `no answer after ${timeoutMs / 1000} s` };
    }
    if (answer !== signed.txid) {
      return { kind: 'unknown', txid: signed.txid, detail: `the server answered with txid ${answer}` };
    }
    return { kind: 'accepted', txid: answer };
  } catch (error) {
    if (error instanceof BroadcastRejectedError) {
      if (isAlreadyKnownRejection(error.detail)) return { kind: 'accepted', txid: signed.txid };
      return { kind: 'rejected', detail: error.detail, alreadySpent: isSpentInputRejection(error.detail) };
    }
    return { kind: 'unknown', txid: signed.txid, detail: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * `Check again` after an unknown broadcast: whether the server now knows the cancel. A lookup error
 * means "not found here", which is what enables `Broadcast again`.
 */
export const serverHasTransaction = async (chain: RecoverChain, txid: string): Promise<boolean> => {
  try {
    await chain.getRawTransaction(txid);
    return true;
  } catch {
    return false;
  }
};
