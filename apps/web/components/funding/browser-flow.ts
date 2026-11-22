'use client';

import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { getChain } from '@/lib/chain/client';
import { chainNetworkProvider } from '@/lib/chain/provider';
import { chainErrorCode, isChainError } from '@/lib/chain/types';
import { appNetwork } from '@/lib/network';
import {
  broadcastRejected,
  broadcastUnknown,
  fundingAwaitingSignature,
  fundingSent,
  registrationDelayed,
  signDeclined,
  transactionNotSent,
} from '@/lib/notifications/messages';
import { followOrder, getNotificationCenter } from '@/lib/notifications/store';
import type { AppNotification } from '@/lib/notifications/types';
import { scanWallet } from '@/lib/wallet/scan';
import { broadcastSigned, signDraft } from '@/lib/wallet/sign';
import { getWalletConnector, walletScanKey } from '@/lib/wallet/store';
import { deleteDraft, dropSignedHex, keepSignedHex, saveDraft, type StoredDraft } from '@/lib/orders/draft-store';
import { previewFunding } from './fees';
import { FundingFlow, type FundingPhase } from './flow';
import type { DerivedOrder } from './order-terms';

const scanCode = (error: unknown): string =>
  isChainError(error) ? chainErrorCode(error) : 'WALLET_SCAN_FAILED';

export interface BrowserFlowOptions {
  readonly draftId: string;
  readonly order: DerivedOrder;
  readonly minimumAmount: bigint;
  readonly feePerByte: bigint;
  readonly ownerPkhHex: string;
  /** `Funding sent` body: what moved, compact (DD 4). */
  readonly amountText: string;
  /** Written when the dialog reaches review (funding-confirmation.md "Draft"). */
  readonly draft: StoredDraft;
  readonly queryClient: QueryClient;
  readonly onRegistered: (txid: string) => void;
}

/**
 * The funding flow wired to the browser: Electrum through `packages/chain`, the WizardConnect session,
 * the API, the notification center and this tab's draft storage. Every flow message goes through the
 * center with the dialog as its owner, so it is recorded, not raised over the dialog.
 */
export const createBrowserFlow = (options: BrowserFlowOptions): FundingFlow => {
  const flowRef = { kind: 'funding' as const, subject: options.draftId };
  let attempt = 0;
  const requestId = () => `${options.draftId}:${attempt.toString()}`;
  const center = getNotificationCenter();
  const notify = (notification: AppNotification) => center.notify(notification);
  const refreshBalances = () =>
    void options.queryClient.invalidateQueries({ queryKey: walletScanKey(options.ownerPkhHex) });

  const flow: FundingFlow = new FundingFlow({
    scanUtxos: async () => {
      const scan = await scanWallet(getChain(), getWalletConnector().pubkeyAt);
      options.queryClient.setQueryData(walletScanKey(options.ownerPkhHex), scan);
      return scan.utxos;
    },
    scanErrorCode: scanCode,
    build: (utxos) =>
      previewFunding({
        params: options.order.params,
        amount: options.order.amount,
        minimumAmount: options.minimumAmount,
        walletUtxos: utxos,
        feePerByte: options.feePerByte,
        network: appNetwork.network,
        provider: chainNetworkProvider(getChain(), appNetwork),
      }),
    expectedOrderLocking: options.order.orderLockingBytecode,
    sign: (draft, signal) => signDraft(getWalletConnector(), draft, signal),
    broadcast: (signed) => broadcastSigned(getChain(), signed),
    seen: async (txid) => {
      try {
        await getChain().getTransactionStatus(txid);
        return true;
      } catch (error) {
        // Electrum answers an unknown txid with a request error: that is "not found", not a failure.
        if (isChainError(error) && error.reason === 'request_failed') return false;
        throw error;
      }
    },
    register: (txid) => api.registerOrder(txid),
    registerErrorCode: (error) => (isApiError(error) ? error.displayCode : 'API_ERROR'),
    endpointLabel: () => getChain().endpointLabel ?? null,
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle),
    onEvent: (event) => {
      switch (event.type) {
        case 'review_ready':
          saveDraft(options.draft);
          return;
        case 'awaiting_signature':
          attempt += 1;
          notify(fundingAwaitingSignature(options.draftId));
          return;
        case 'declined':
          notify(signDeclined(flowRef, requestId()));
          return;
        case 'not_sent':
          notify(transactionNotSent(flowRef, requestId(), event.code, event.reason, null));
          return;
        case 'broadcast_rejected':
          notify(broadcastRejected(flowRef, requestId(), event.message, null));
          return;
        case 'signed':
          deleteDraft(options.draftId);
          keepSignedHex(event.signed.txid, event.signed.hex);
          return;
        case 'funding_sent':
          dropSignedHex(event.txid);
          followOrder(`${event.txid}:0`);
          refreshBalances();
          notify(fundingSent({ draftId: options.draftId, txid: event.txid, amountText: options.amountText }));
          return;
        case 'register_failed':
          notify(registrationDelayed({ draftId: options.draftId, txid: event.txid, code: event.code }));
          return;
        case 'broadcast_unknown':
          notify(
            broadcastUnknown({ flow: flowRef, txid: event.txid, checkAgain: () => void flow.checkAgain() }),
          );
          return;
        case 'registered':
          options.onRegistered(event.txid);
      }
    },
  });
  return flow;
};

/**
 * The toast raised when the dialog closes after the funding was broadcast (notifications.md "Flow
 * ownership"): `Funding sent`, or #12 / #15 when it closed in `register failed` / `broadcast unknown`.
 */
export const closingNotification = (
  phase: FundingPhase,
  options: { readonly draftId: string; readonly amountText: string; readonly checkAgain: () => void },
): AppNotification | null => {
  const flow = { kind: 'funding' as const, subject: options.draftId };
  switch (phase.kind) {
    case 'registering':
    case 'registered':
      return fundingSent({ draftId: options.draftId, txid: phase.txid, amountText: options.amountText });
    case 'register_failed':
      return registrationDelayed({ draftId: options.draftId, txid: phase.txid, code: phase.code });
    case 'broadcast_unknown':
      return broadcastUnknown({ flow, txid: phase.signed.txid, checkAgain: options.checkAgain });
    default:
      return null;
  }
};
