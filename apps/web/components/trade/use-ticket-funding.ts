'use client';

import {
  BUY_PAYOUT_SATS,
  FUNDING_MARKER_SATS,
  minimumMinOut,
  ownerLockingBytecode,
  type OrderParams,
  type OrderSide,
} from '@atprice/core';
import { useMemo } from 'react';
import type { FeeDisclosureValues } from '@/components/fee-disclosure';
import type { NetworkStatus } from '@/lib/api/schemas';
import { appNetwork } from '@/lib/network';
import type { OwnerIdentity } from '@/lib/wallet/keys';
import type { WalletScan } from '@/lib/wallet/scan';
import {
  estimateCancelFee,
  estimateFees,
  maxBuySpend,
  offlineProvider,
  previewFunding,
  type FundingPreview,
} from '../funding/fees';
import { MAX_NETWORK_FEE } from '../funding/order-terms';

/** Size-only nonce for previews: the real one is drawn fresh at `Review order` (DD 7.2 step b). */
const PREVIEW_NONCE = Uint8Array.of(1, 1, 1, 1, 1, 1, 1, 1);

export interface TicketFundingInput {
  readonly owner: OwnerIdentity | null;
  readonly recipientBytes: Uint8Array | null;
  readonly side: OrderSide;
  readonly tokenCategory: string;
  readonly minOut: bigint | null;
  readonly scan: WalletScan | undefined;
  readonly network: NetworkStatus | undefined;
  readonly amount: bigint | null;
  readonly minimumAmount: bigint;
  readonly tokenBalance: bigint;
}

export interface TicketFunding {
  readonly previewParams: OrderParams | null;
  /** Core's funding builder over the wallet's coins: the balance checks quote its numbers. */
  readonly preview: FundingPreview | null;
  readonly fees: FeeDisclosureValues | null;
  /** `Max` (buy: spendable BCH less every fee and reserve; sell: the token balance). */
  readonly maxValue: bigint | null;
}

/**
 * Everything the ticket learns from `@atprice/core`'s funding builder before an order exists. Each
 * build is memoised on its inputs, so the one-second clocks elsewhere on the page don't rebuild it.
 */
export const useTicketFunding = (input: TicketFundingInput): TicketFunding => {
  const {
    owner,
    recipientBytes,
    side,
    tokenCategory,
    minOut,
    scan,
    network,
    amount,
    minimumAmount,
    tokenBalance,
  } = input;
  const feePerByte = network?.feeRateSatsPerByte ?? null;

  const previewParams = useMemo((): OrderParams | null => {
    if (owner === null) return null;
    return {
      side,
      ownerPkh: owner.ownerPkh,
      recipientLockingBytecode: recipientBytes ?? ownerLockingBytecode(owner.ownerPkh),
      tokenCategory,
      minOut: minOut ?? minimumMinOut(side),
      maxNetworkFee: MAX_NETWORK_FEE,
      nonce: PREVIEW_NONCE,
    };
  }, [owner, recipientBytes, side, tokenCategory, minOut]);

  const preview = useMemo((): FundingPreview | null => {
    if (previewParams === null || scan === undefined || feePerByte === null || amount === null) return null;
    if (amount < minimumAmount) return null;
    return previewFunding({
      params: previewParams,
      amount,
      minimumAmount,
      walletUtxos: scan.utxos,
      feePerByte,
      network: appNetwork.network,
      provider: offlineProvider(appNetwork.network),
    });
  }, [previewParams, scan, feePerByte, amount, minimumAmount]);

  const fees = useMemo((): FeeDisclosureValues | null => {
    if (network === undefined) return null;
    const rate = network.feeRateSatsPerByte;
    let funding: { sats: bigint; bytes: number; cancel: bigint; kept: bigint } | null = null;
    if (preview?.kind === 'ok' && previewParams !== null) {
      funding = {
        sats: preview.draft.fee,
        bytes: preview.draft.estimatedSize,
        cancel: estimateCancelFee(previewParams, preview.draft, rate, offlineProvider(appNetwork.network)),
        kept: preview.draft.ownerOutputSatoshis,
      };
    } else {
      const estimate = estimateFees({
        side,
        tokenCategory,
        network: appNetwork.network,
        feePerByte: rate,
        ownerPkh: owner?.ownerPkh ?? null,
        recipientLockingBytecode: recipientBytes,
        amount: amount !== null && amount >= minimumAmount ? amount : null,
        minOut,
        minimumAmount,
      });
      if (estimate !== null) {
        funding = {
          sats: estimate.fundingFee,
          bytes: estimate.fundingBytes,
          cancel: estimate.cancelFee,
          kept: FUNDING_MARKER_SATS,
        };
      }
    }
    if (funding === null) return null;
    return {
      side,
      protocolFeeBps: network.protocolFeeBps,
      fundingFee: { basis: 'estimate', sats: funding.sats, bytes: funding.bytes, satsPerByte: rate },
      maxNetworkFee: MAX_NETWORK_FEE,
      cancelFeeEstimate: funding.cancel,
      tokenDust: side === 'buy' ? BUY_PAYOUT_SATS : null,
      keptForCancel: { kind: funding.kept === FUNDING_MARKER_SATS ? 'marker' : 'change', sats: funding.kept },
    };
  }, [
    network,
    preview,
    previewParams,
    side,
    tokenCategory,
    owner,
    recipientBytes,
    amount,
    minimumAmount,
    minOut,
  ]);

  const maxValue = useMemo((): bigint | null => {
    if (scan === undefined || previewParams === null || feePerByte === null) return null;
    if (side === 'sell') return tokenBalance;
    return maxBuySpend(
      (spend) =>
        previewFunding({
          params: previewParams,
          amount: spend,
          minimumAmount: 0n,
          walletUtxos: scan.utxos,
          feePerByte,
          network: appNetwork.network,
          provider: offlineProvider(appNetwork.network),
        }),
      scan.bchSats,
    );
  }, [scan, previewParams, feePerByte, side, tokenBalance]);

  return { previewParams, preview, fees, maxValue };
};
