import { binToHex, encodeLockingBytecodeP2pkh, hash256, hexToBin } from '@bitauth/libauth';
import {
  AtPriceError,
  BUY_PAYOUT_SATS,
  buildCancelTransaction,
  buildFundingTransaction,
  FUNDING_MARKER_SATS,
  InsufficientFundsError,
  instantiateOrder,
  minimumMinOut,
  orderFunding,
  ownerLockingBytecode,
  type FundingDraft,
  type Network,
  type OrderParams,
  type OrderSide,
  type WalletUtxo,
} from '@atprice/core';
import type { NetworkProvider } from 'cashscript';
import { MAX_NETWORK_FEE } from './order-terms';

/*
 * Fee figures for the ticket and the funding confirmation (DD 7.4). Every byte count comes from a
 * transaction `@atprice/core` builds; nothing here re-implements a builder or a size formula.
 */

const noNetwork = (): Promise<never> =>
  Promise.reject(new Error('Fee estimates are computed offline and never read the network.'));

/** Core's builders take a provider but only read it to send; estimates never send, so none is reachable. */
export const offlineProvider = (network: Network): NetworkProvider => ({
  network,
  getUtxos: noNetwork,
  getUtxosForLockingBytecode: noNetwork,
  getBlockHeight: noNetwork,
  getRawTransaction: noNetwork,
  sendRawTransaction: noNetwork,
});

/** The txid of an unsigned transaction's bytes, display order. */
export const unsignedTxid = (unsignedHex: string): string =>
  binToHex(hash256(hexToBin(unsignedHex)).reverse());

export type FundingPreview =
  | { readonly kind: 'ok'; readonly draft: FundingDraft }
  | {
      readonly kind: 'short';
      readonly resource: 'bch' | 'tokens';
      readonly required: bigint;
      readonly available: bigint;
    }
  | { readonly kind: 'invalid'; readonly error: AtPriceError };

export interface FundingPreviewInput {
  readonly params: OrderParams;
  readonly amount: bigint;
  readonly minimumAmount: bigint;
  readonly walletUtxos: readonly WalletUtxo[];
  readonly feePerByte: bigint;
  readonly network: Network;
  readonly provider: NetworkProvider;
}

/**
 * Runs core's funding builder. A shortfall comes back with core's own `required` and `available`, so
 * the ticket's "BCH short" reasons quote the builder's numbers, never a second formula.
 */
export const previewFunding = (input: FundingPreviewInput): FundingPreview => {
  try {
    const draft = buildFundingTransaction({
      params: input.params,
      amount: input.amount,
      minimumAmount: input.minimumAmount,
      walletUtxos: input.walletUtxos,
      network: input.network,
      provider: input.provider,
      feePerByte: input.feePerByte,
    });
    return { kind: 'ok', draft };
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      return {
        kind: 'short',
        resource: error.reason === 'insufficient_bch' ? 'bch' : 'tokens',
        required: error.required,
        available: error.available,
      };
    }
    if (error instanceof AtPriceError) return { kind: 'invalid', error };
    throw error;
  }
};

/**
 * The cancel fee this order would pay at `feePerByte` (DD 7.4 "Cancel network fee"): core builds the
 * `cancel()` that spends the funding draft's order output with the funding marker as its owner input.
 */
export const estimateCancelFee = (
  params: OrderParams,
  draft: FundingDraft,
  feePerByte: bigint,
  provider: NetworkProvider,
): bigint => {
  const txid = unsignedTxid(draft.unsignedHex);
  const tokenAmount = draft.funding.tokenAmount;
  const cancel = buildCancelTransaction({
    owner: { utxos: [{ txid, vout: 2, satoshis: draft.ownerOutputSatoshis }] },
    orders: [
      {
        order: instantiateOrder(params, provider),
        utxo: {
          txid,
          vout: 0,
          satoshis: draft.funding.satoshis,
          ...(tokenAmount > 0n && { token: { category: params.tokenCategory, amount: tokenAmount } }),
        },
      },
    ],
    feePerByte,
  });
  return cancel.fee < params.maxNetworkFee ? cancel.fee : params.maxNetworkFee;
};

export interface FeeEstimate {
  readonly fundingFee: bigint;
  readonly fundingBytes: number;
  readonly cancelFee: bigint;
}

export interface EstimateInput {
  readonly side: OrderSide;
  readonly tokenCategory: string;
  readonly network: Network;
  readonly feePerByte: bigint;
  /** Each a real value when known; byte sizes don't depend on these values, only on their encodings. */
  readonly ownerPkh: Uint8Array | null;
  readonly recipientLockingBytecode: Uint8Array | null;
  readonly amount: bigint | null;
  readonly minOut: bigint | null;
  readonly minimumAmount: bigint;
}

/** Stand-in bytes of the right length where a value isn't known yet (no wallet, no amount). */
const STAND_IN_PKH = new Uint8Array(20).fill(1);
const STAND_IN_NONCE = new Uint8Array(8).fill(1);
const STAND_IN_TXID = '01'.repeat(32);

/**
 * The ticket's `about` funding and cancel fees before a funding transaction exists (DD 7.4): core
 * builds a funding of the same shape (side, recipient type, one wallet input, plus the token input of
 * a sell) and the cancel that would spend it. Transaction size depends on the shape and on the length
 * of each field, not on key, nonce or txid values, so stand-ins of the right length give the real size.
 */
export const estimateFees = (input: EstimateInput): FeeEstimate | null => {
  const ownerPkh = input.ownerPkh ?? STAND_IN_PKH;
  const amount = input.amount ?? input.minimumAmount;
  const params: OrderParams = {
    side: input.side,
    ownerPkh,
    recipientLockingBytecode: input.recipientLockingBytecode ?? ownerLockingBytecode(ownerPkh),
    tokenCategory: input.tokenCategory,
    minOut: input.minOut ?? minimumMinOut(input.side),
    maxNetworkFee: MAX_NETWORK_FEE,
    nonce: STAND_IN_NONCE,
  };
  let funding: { satoshis: bigint; tokenAmount: bigint };
  try {
    funding = orderFunding(params, amount, 0n);
  } catch (error) {
    if (error instanceof AtPriceError) return null;
    throw error;
  }
  const lockingBytecode = binToHex(encodeLockingBytecodeP2pkh(ownerPkh));
  const coins: WalletUtxo[] = [
    {
      txid: STAND_IN_TXID,
      vout: 0,
      satoshis: funding.satoshis + FUNDING_MARKER_SATS + 1_000_000n,
      lockingBytecode,
      pathName: 'receive',
      addressIndex: 0,
    },
  ];
  if (funding.tokenAmount > 0n) {
    coins.push({
      txid: STAND_IN_TXID,
      vout: 1,
      satoshis: 1_000n,
      lockingBytecode,
      pathName: 'receive',
      addressIndex: 0,
      token: { category: input.tokenCategory, amount: funding.tokenAmount },
    });
  }
  const provider = offlineProvider(input.network);
  const preview = previewFunding({
    params,
    amount,
    minimumAmount: 0n,
    walletUtxos: coins,
    feePerByte: input.feePerByte,
    network: input.network,
    provider,
  });
  if (preview.kind !== 'ok') return null;
  return {
    fundingFee: preview.draft.fee,
    fundingBytes: preview.draft.estimatedSize,
    cancelFee: estimateCancelFee(params, preview.draft, input.feePerByte, provider),
  };
};

/**
 * `Max` for a buy (trade.md "Controls"): spendable BCH minus the funding fee, `maxNetworkFee`, the
 * 1,000 sat token dust and the 1,000 sat cancel marker. Core prices the funding fee: start from the
 * fee-free figure and step down by the shortfall core reports until the funding builds.
 */
export const maxBuySpend = (
  build: (spend: bigint) => FundingPreview,
  spendableSats: bigint,
): bigint | null => {
  let spend = spendableSats - MAX_NETWORK_FEE - BUY_PAYOUT_SATS - FUNDING_MARKER_SATS;
  for (let attempt = 0; attempt < 4 && spend > 0n; attempt += 1) {
    const preview = build(spend);
    if (preview.kind === 'ok') return spend;
    if (preview.kind !== 'short' || preview.resource !== 'bch') return null;
    spend -= preview.required - spendableSats;
  }
  return null;
};
