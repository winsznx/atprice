import { useQuery } from '@tanstack/react-query';
import { queries } from '@/lib/api/queries';
import type { EvidenceOrder, FillSettlement } from '@/lib/api/schemas';
import { formatPercent, formatSignedUnits } from '@/lib/format';
import { aboveMinimum, displayMinimum, marketOf } from '@/lib/orders/display';

/** How many completed orders the home page reads. The hero and Live proof share this one query. */
export const PROOF_LIMIT = 20;
export const RECENT_LIMIT = 5;
export const PROOF_REFRESH_MS = 30_000;

export const useProofEvidence = () =>
  useQuery({ ...queries.evidence(null, PROOF_LIMIT), refetchInterval: PROOF_REFRESH_MS });

export type FilledOrder = EvidenceOrder & { readonly settlement: FillSettlement };

const isFill = (order: EvidenceOrder): order is FilledOrder => order.settlement.kind === 'fill';

/** The newest completed fill in the list (the API lists newest first), or null when none is listed. */
export const latestFill = (orders: readonly EvidenceOrder[]): FilledOrder | null => orders.find(isFill) ?? null;

export interface ProofCounts {
  /** Completed orders the counts below were taken from. */
  readonly counted: number;
  /** True when the server said there are no older orders, so `counted` is every completed order. */
  readonly complete: boolean;
  readonly fills: number;
  readonly cancels: number;
  /** Fills whose payout was strictly above the order's minimum. */
  readonly fillsAboveMinimum: number;
  /** Fills AtPrice's keeper broadcast, from its own attempt records (DD 7.7 `Filled by`). */
  readonly keeperFills: number;
  readonly newestBlock: number | null;
}

/** Everything here is counted from the evidence page itself; nothing is estimated or extrapolated. */
export const proofCounts = (orders: readonly EvidenceOrder[], nextCursor: string | null): ProofCounts => {
  const fills = orders.filter(isFill);
  return {
    counted: orders.length,
    complete: nextCursor === null,
    fills: fills.length,
    cancels: orders.length - fills.length,
    fillsAboveMinimum: fills.filter((order) => aboveMinimum(order, order.settlement.received) > 0n).length,
    keeperFills: fills.filter((order) => order.settlement.filledBy === 'atprice_keeper').length,
    newestBlock: orders.reduce<number | null>(
      (newest, order) => (newest === null || order.settlementBlock.height > newest ? order.settlementBlock.height : newest),
      null,
    ),
  };
};

/**
 * DD 7.7 `Above your minimum`, signed, in the payout's unit, with its share of the minimum the user
 * set (DD 4.1 `minProceeds`, so a sell's 2,000 sat reserve is not counted as price). The percentage is
 * null for an order without a positive minimum.
 */
export const aboveMinimumParts = (order: FilledOrder): { readonly amount: string; readonly percent: string | null } => {
  const surplus = aboveMinimum(order, order.settlement.received);
  const market = marketOf(order.tokenCategory);
  const decimals = order.side === 'buy' ? (market?.decimals ?? 0) : 8;
  const unit = order.side === 'buy' ? (market?.symbol ?? 'units') : 'BCH';
  const minimum = displayMinimum(order);
  const base = minimum.kind === 'tokens' ? minimum.units : minimum.kind === 'sats' ? minimum.sats : null;
  return {
    amount: `${formatSignedUnits(surplus, decimals, 'exact')} ${unit}`,
    percent: base === null || base <= 0n ? null : formatPercent(surplus, base, { signed: true }),
  };
};
