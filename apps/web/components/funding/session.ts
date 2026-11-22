import type { MarketDefinition } from '@atprice/core';
import type { RateOrientation } from '@/lib/format';
import type { FundingFlow } from './flow';
import type { DerivedOrder } from './order-terms';

/** One funding confirmation: the browser-derived order shown and signed, plus what the dialog prints. */
export interface FundingSession {
  readonly draftId: string;
  readonly flow: FundingFlow;
  readonly order: DerivedOrder;
  readonly market: MarketDefinition;
  /** Buy: `minOut` tokens. Sell: net proceeds `P` sats (DD 4.1). */
  readonly minProceeds: bigint;
  readonly limit: { readonly text: string; readonly orientation: RateOrientation };
  /** The address the fill pays, as entered or the owner's own. */
  readonly recipientAddress: string;
  readonly recipientIsWallet: boolean;
  /** `receive/0` P2PKH address: where funding output 2 lands. */
  readonly ownerAddress: string;
  readonly ownerPkhHex: string;
  /** `matched`: the server derived the same address. `limit_reached`: 429, register-only fallback. */
  readonly verification: 'matched' | 'limit_reached';
  readonly feePerByte: bigint;
  readonly protocolFeeBps: number;
}
