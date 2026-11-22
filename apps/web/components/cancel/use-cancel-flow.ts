'use client';

import { isSpentInputRejection } from '@atprice/chain';
import { decodeTransactionHex, type SignedTransaction } from '@atprice/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/queries';
import type { Order } from '@/lib/api/schemas';
import { getChain } from '@/lib/chain/client';
import { chainErrorCode, isChainError } from '@/lib/chain/types';
import {
  broadcastRejected,
  cancelAwaitingSignature,
  cancelRaceLost,
  signDeclined,
  transactionNotSent,
} from '@/lib/notifications/messages';
import { getNotificationCenter, markCancelSent } from '@/lib/notifications/store';
import type { MessageFlow } from '@/lib/notifications/types';
import { BROADCAST_TIMEOUT_MS } from '@/lib/wallet/constants';
import { broadcastSigned, signDraft } from '@/lib/wallet/sign';
import { getWalletConnector, walletScanKey } from '@/lib/wallet/store';
import { isWalletError } from '@/lib/wallet/errors';
import {
  buildOwnerCancel,
  buildSignatureCancel,
  CancelBuildInvalidError,
  findOrderSpend,
  orderStillUnspent,
  readOrderFromChain,
  type BuiltCancel,
  type OrderOnChain,
  type OrderSpendSeen,
} from './cancel-build';
import {
  CANCEL_RULE_TEXT,
  checkCancelRules,
  compareWithServer,
  signedDifference,
  type ServerCheck,
} from './cancel-rules';


export type CancelFlowState =
  | { readonly kind: 'reading' }
  | { readonly kind: 'review'; readonly built: BuiltCancel; readonly server: ServerCheck }
  | {
      readonly kind: 'no_coin';
      readonly requiredSatoshis: bigint;
      readonly since: number;
      readonly checking: boolean;
    }
  | { readonly kind: 'already_spent'; readonly spend: OrderSpendSeen | null }
  | { readonly kind: 'awaiting'; readonly built: BuiltCancel; readonly since: number }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'signing_error'; readonly reason: string }
  | { readonly kind: 'changed'; readonly rule: string }
  | {
      readonly kind: 'broadcasting';
      readonly signed: SignedTransaction;
      readonly refundText: string;
      readonly since: number;
    }
  | {
      readonly kind: 'unknown';
      readonly signed: SignedTransaction;
      readonly refundText: string;
      readonly lookedUp: boolean;
      readonly checking: boolean;
      readonly lookupCode: string | null;
    }
  | { readonly kind: 'sent'; readonly txid: string; readonly refundText: string }
  | { readonly kind: 'race_lost'; readonly spend: Extract<OrderSpendSeen, { path: 'execute' }> }
  | { readonly kind: 'rejected_other'; readonly message: string }
  | { readonly kind: 'chain_error'; readonly code: string; readonly host: string | null }
  | { readonly kind: 'build_invalid'; readonly rule: string }
  | { readonly kind: 'derivation_mismatch' }
  | { readonly kind: 'not_owner' };

export type CancelFlowKind = CancelFlowState['kind'];

/** States in which nothing has been signed: a disconnect sends the dialog back to the owner check. */
export const PRE_SIGNING: readonly CancelFlowKind[] = [
  'reading',
  'review',
  'no_coin',
  'rejected',
  'signing_error',
  'chain_error',
  'not_owner',
];

const flowOf = (orderId: string): MessageFlow & { kind: 'cancel' } => ({ kind: 'cancel', subject: orderId });

const chainFailure = (error: unknown): { code: string; host: string | null } => ({
  code: isChainError(error) ? chainErrorCode(error) : 'ELECTRUM_UNREACHABLE',
  host: getChain().endpointLabel ?? null,
});

export interface CancelFlowInput {
  readonly order: Order;
  readonly ownerPkhHex: string | null;
  /** Formats the refund for the `Cancel sent` toast. */
  readonly refundText: (built: BuiltCancel) => string;
  /** Called when the cancel reached the network: the dialog closes and raises `Cancel sent`. */
  readonly onSent: (sent: Extract<CancelFlowState, { kind: 'sent' }>) => void;
}

export interface CancelFlow {
  readonly state: CancelFlowState;
  /** Chain data the build used; the `no_coin` state subscribes to its owner address. */
  readonly onChain: OrderOnChain | null;
  readonly retry: () => void;
  readonly sign: () => void;
  readonly cancelRequest: () => void;
  readonly checkCoinAgain: () => void;
  readonly signInsideContract: () => void;
  readonly checkBroadcastAgain: () => void;
  readonly broadcastAgain: () => void;
}

/**
 * The cancel flow (cancel-confirmation.md "Flow states"). Every async step carries the run it started
 * in, so an answer that arrives after `Try again`, a newer step or a close is dropped instead of
 * overwriting newer state.
 */
export function useCancelFlow({ order, ownerPkhHex, refundText, onSent }: CancelFlowInput): CancelFlow {
  const queryClient = useQueryClient();
  const [state, setState] = useState<CancelFlowState>({ kind: 'reading' });
  const [onChain, setOnChain] = useState<OrderOnChain | null>(null);
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  const onSentRef = useRef(onSent);
  useEffect(() => {
    stateRef.current = state;
    onSentRef.current = onSent;
  });

  const toSent = (txid: string, refund: string): void => {
    const sent = { kind: 'sent', txid, refundText: refund } as const;
    setState(sent);
    onSentRef.current(sent);
  };

  const setFor =
    (token: number) =>
    (next: CancelFlowState): void => {
      if (run.current === token) setState(next);
    };

  const refreshAfterSpend = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.orders() });
    if (ownerPkhHex !== null) void queryClient.invalidateQueries({ queryKey: walletScanKey(ownerPkhHex) });
  };

  const compareServer = (token: number, built: BuiltCancel): void => {
    api
      .prepareCancel(order.id)
      .then((prepared): ServerCheck =>
        compareWithServer(built.draft.unsignedHex, prepared.unsignedHex, built.ruleContext),
      )
      .catch(
        (error: unknown): ServerCheck => ({
          kind: 'unavailable',
          code: isApiError(error) ? error.displayCode : 'API_ERROR',
        }),
      )
      .then((server) => {
        if (run.current !== token) return;
        setState((current) =>
          current.kind === 'review' && current.built === built ? { ...current, server } : current,
        );
      });
  };

  const toReview = (token: number, built: BuiltCancel): void => {
    setFor(token)({
      kind: 'review',
      built,
      server: built.path === 'cancel' ? { kind: 'pending' } : { kind: 'not_applicable' },
    });
    if (built.path === 'cancel') compareServer(token, built);
  };

  const failBuild = (token: number, error: unknown): void => {
    const set = setFor(token);
    if (error instanceof CancelBuildInvalidError) {
      console.error(`${error.message}. Unsigned transaction hex: ${error.hex}`);
      set({ kind: 'build_invalid', rule: CANCEL_RULE_TEXT[error.rule] });
      return;
    }
    if (isChainError(error)) {
      set({ kind: 'chain_error', ...chainFailure(error) });
      return;
    }
    console.error('Cancel build failed:', error);
    set({ kind: 'build_invalid', rule: error instanceof Error ? error.message : String(error) });
  };

  const buildFrom = async (token: number, current: OrderOnChain, since: number | null): Promise<void> => {
    const result = await buildOwnerCancel(getChain(), current);
    if (result.kind === 'built') {
      toReview(token, result.built);
      return;
    }
    setFor(token)({
      kind: 'no_coin',
      requiredSatoshis: result.requiredSatoshis,
      since: since ?? Date.now(),
      checking: false,
    });
  };

  const start = (): void => {
    const token = ++run.current;
    abort.current?.abort();
    setState({ kind: 'reading' });
    if (ownerPkhHex === null) return;
    void (async () => {
      try {
        const read = await readOrderFromChain(getChain(), order.funding.txid, ownerPkhHex);
        if (run.current !== token) return;
        switch (read.kind) {
          case 'not_owner':
            setState({ kind: 'not_owner' });
            return;
          case 'derivation_mismatch':
            setState({ kind: 'derivation_mismatch' });
            return;
          case 'spent':
            setState({ kind: 'already_spent', spend: read.spend });
            return;
          case 'ready':
            setOnChain(read.onChain);
            await buildFrom(token, read.onChain, null);
        }
      } catch (error) {
        failBuild(token, error);
      }
    })();
  };

  // The wallet is an external system: connecting (again) as some wallet re-runs the owner check and
  // the build, but never once something has been signed.
  const onWalletOwner = useEffectEvent(() => {
    if (ownerPkhHex !== null && PRE_SIGNING.includes(stateRef.current.kind)) start();
  });
  useEffect(() => onWalletOwner(), [ownerPkhHex]);

  useEffect(
    () => () => {
      run.current += 1;
      abort.current?.abort();
    },
    [],
  );

  const checkCoinAgain = (): void => {
    const current = stateRef.current;
    if (current.kind !== 'no_coin' || onChain === null) return;
    const token = ++run.current;
    setState({ ...current, checking: true });
    buildFrom(token, onChain, current.since).catch((error: unknown) => failBuild(token, error));
  };

  const signInsideContract = (): void => {
    if (onChain === null) return;
    const token = ++run.current;
    try {
      toReview(token, buildSignatureCancel(onChain));
    } catch (error) {
      failBuild(token, error);
    }
  };

  const spendOfOrder = async (current: OrderOnChain): Promise<OrderSpendSeen | null> =>
    findOrderSpend(getChain(), current.params, {
      txid: current.orderUtxo.txid,
      vout: current.orderUtxo.vout,
      coin: current.orderUtxo,
    });

  const settleRejection = async (
    token: number,
    signed: SignedTransaction,
    refund: string,
    detail: string,
  ): Promise<void> => {
    const set = setFor(token);
    if (onChain !== null && isSpentInputRejection(detail)) {
      const spend = await spendOfOrder(onChain);
      if (spend?.txid === signed.txid) {
        refreshAfterSpend();
        if (run.current === token) toSent(signed.txid, refund);
        return;
      }
      if (spend?.path === 'execute') {
        refreshAfterSpend();
        getNotificationCenter().notify(cancelRaceLost(order));
        set({ kind: 'race_lost', spend });
        return;
      }
    }
    getNotificationCenter().notify(broadcastRejected(flowOf(order.id), signed.txid, detail, null));
    set({ kind: 'rejected_other', message: detail });
  };

  const broadcast = (token: number, signed: SignedTransaction, refund: string): void => {
    const set = setFor(token);
    markCancelSent(order.id);
    set({ kind: 'broadcasting', signed, refundText: refund, since: Date.now() });
    const unknown: CancelFlowState = {
      kind: 'unknown',
      signed,
      refundText: refund,
      lookedUp: false,
      checking: false,
      lookupCode: null,
    };
    // Only the timer's own `broadcasting` state is replaced: a late answer still lands in `unknown`.
    const timer = setTimeout(() => {
      if (run.current === token && stateRef.current.kind === 'broadcasting') setState(unknown);
    }, BROADCAST_TIMEOUT_MS);
    broadcastSigned(getChain(), signed)
      .then(async (outcome) => {
        clearTimeout(timer);
        if (run.current !== token) return;
        switch (outcome.kind) {
          case 'accepted':
            refreshAfterSpend();
            toSent(signed.txid, refund);
            return;
          case 'rejected':
            await settleRejection(token, signed, refund, outcome.detail);
            return;
          case 'unknown':
            setState(unknown);
        }
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        console.error('Cancel broadcast handling failed:', error);
        set({ ...unknown, lookupCode: chainFailure(error).code });
      });
  };

  const notSent = (requestId: string, code: 'WALLET_SESSION_ENDED' | 'SIGNED_TX_MISMATCH', reason: string) =>
    getNotificationCenter().notify(transactionNotSent(flowOf(order.id), requestId, code, reason, null));

  const sign = (): void => {
    const current = stateRef.current;
    if (current.kind !== 'review' || onChain === null) return;
    const { built, server } = current;
    const token = ++run.current;
    const set = setFor(token);
    const requestId = crypto.randomUUID();
    void (async () => {
      try {
        if (!(await orderStillUnspent(getChain(), onChain))) {
          const spend = await spendOfOrder(onChain);
          refreshAfterSpend();
          set({ kind: 'already_spent', spend });
          return;
        }
      } catch (error) {
        set({ kind: 'chain_error', ...chainFailure(error) });
        return;
      }
      if (run.current !== token) return;
      const controller = new AbortController();
      abort.current = controller;
      getNotificationCenter().notify(cancelAwaitingSignature(order.id, requestId));
      setState({ kind: 'awaiting', built, since: Date.now() });
      let signed: SignedTransaction;
      try {
        signed = await signDraft(getWalletConnector(), built.draft, controller.signal);
      } catch (error) {
        if (run.current !== token) return;
        const reason = error instanceof Error ? error.message : String(error);
        if (isWalletError(error) && error.code === 'SIGN_REQUEST_CANCELLED') {
          setState({ kind: 'review', built, server });
        } else if (isWalletError(error) && error.code === 'WALLET_DECLINED') {
          getNotificationCenter().notify(signDeclined(flowOf(order.id), requestId));
          setState({ kind: 'rejected' });
        } else if (isWalletError(error) && error.code === 'SIGNED_TX_MISMATCH') {
          notSent(requestId, 'SIGNED_TX_MISMATCH', reason);
          setState({ kind: 'changed', rule: reason });
        } else {
          notSent(requestId, 'WALLET_SESSION_ENDED', reason);
          setState({ kind: 'signing_error', reason });
        }
        return;
      }
      if (run.current !== token) return;
      const signedTx = decodeTransactionHex(signed.hex);
      const difference = signedDifference(decodeTransactionHex(built.draft.unsignedHex), signedTx);
      const rule = difference === null ? checkCancelRules(signedTx, built.ruleContext) : null;
      if (difference !== null || rule !== null) {
        const text =
          rule !== null
            ? CANCEL_RULE_TEXT[rule]
            : difference === 'inputs'
              ? 'it spends different inputs'
              : 'its outputs differ';
        notSent(requestId, 'SIGNED_TX_MISMATCH', `Your wallet returned a different cancel (${text})`);
        setState({ kind: 'changed', rule: text });
        return;
      }
      broadcast(token, signed, refundText(built));
    })();
  };

  const cancelRequest = (): void => abort.current?.abort();

  const checkBroadcastAgain = (): void => {
    const current = stateRef.current;
    if (current.kind !== 'unknown') return;
    const token = run.current;
    setState({ ...current, checking: true });
    getChain()
      .getTransactionStatus(current.signed.txid)
      .then(() => {
        if (run.current !== token) return;
        refreshAfterSpend();
        toSent(current.signed.txid, current.refundText);
      })
      .catch((error: unknown) => {
        if (run.current !== token) return;
        const unreachable = isChainError(error) && chainErrorCode(error) === 'ELECTRUM_UNREACHABLE';
        setState({
          ...current,
          checking: false,
          lookedUp: current.lookedUp || !unreachable,
          lookupCode: unreachable ? 'ELECTRUM_UNREACHABLE' : null,
        });
      });
  };

  const broadcastAgain = (): void => {
    const current = stateRef.current;
    if (current.kind !== 'unknown' || !current.lookedUp) return;
    broadcast(++run.current, current.signed, current.refundText);
  };

  return {
    state,
    onChain,
    retry: start,
    sign,
    cancelRequest,
    checkCoinAgain,
    signInsideContract,
    checkBroadcastAgain,
    broadcastAgain,
  };
}
