import {
  BUY_PAYOUT_SATS,
  FUNDING_MARKER_SATS,
  SELL_ORDER_SATS,
  type MarketDefinition,
  type OrderSide,
} from '@atprice/core';
import type { ReactNode } from 'react';
import { BchAmount, Num, TokenAmount } from '@/components/amount';
import { formatBch, formatFee, formatRateText, formatToken, groupDigits, orientRate } from '@/lib/format';
import type { PriceRatio } from '@atprice/core';
import type { RateOrientation } from '@/lib/format';

/** The limit as typed, with grouping added and nothing else changed (DD 4 "Rates"). */
export const typedLimitText = (text: string): string => {
  const [integer = '0', fraction] = text.trim().split('.');
  const grouped = groupDigits(integer === '' ? '0' : integer.replace(/^0+(?=\d)/, ''));
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};

/**
 * The limit in `PUSD per BCH`: as typed when it was typed in that unit, otherwise derived from the
 * exact ratio (with `≈` when 8 significant figures changed it).
 */
export const tokensPerBchText = (
  typed: { readonly text: string; readonly orientation: RateOrientation },
  price: PriceRatio,
  tokenDecimals: number,
): string => {
  if (typed.orientation === 'tokens_per_bch') return typedLimitText(typed.text);
  const oriented = orientRate(price, tokenDecimals, 'tokens_per_bch');
  return formatRateText(oriented.numerator, oriented.denominator, { term: true });
};

export interface SummaryTerms {
  readonly amount: bigint;
  readonly minOut: bigint;
  /** Buy: tokens. Sell: net proceeds `P` in sats. */
  readonly minProceeds: bigint;
  readonly limitTokensPerBch: string;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 @min-[26rem]:flex-row @min-[26rem]:justify-between @min-[26rem]:gap-4">
      <dt className="shrink-0 text-body-sm text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-body-sm text-fg @min-[26rem]:text-right">{children}</dd>
    </div>
  );
}

/** trade.md "Your order": every amount `exact` (DD 4). */
export function OrderSummary({
  market,
  side,
  terms,
  maxNetworkFee,
}: {
  market: MarketDefinition;
  side: OrderSide;
  terms: SummaryTerms | null;
  maxNetworkFee: bigint;
}) {
  return (
    <section aria-labelledby="your-order-title" className="@container flex flex-col gap-2">
      <h2 id="your-order-title" className="font-display text-heading-3 text-fg">
        Your order
      </h2>
      {terms === null ? (
        <p className="text-body-sm text-fg-secondary">
          Enter an amount and a limit price to see the exact terms your order will lock in.
        </p>
      ) : (
        <dl className="flex flex-col divide-y divide-border">
          <Row label="Direction">
            {side === 'buy' ? `Buy ${market.symbol} with BCH` : `Sell ${market.symbol} for BCH`}
          </Row>
          <Row label="You lock">
            {side === 'buy' ? (
              <span className="flex flex-col gap-1">
                <BchAmount sats={terms.amount + maxNetworkFee + BUY_PAYOUT_SATS} mode="exact" size="md" />
                <Num className="text-caption text-fg-muted">
                  {`${formatBch(terms.amount, 'exact')} BCH order + ${formatBch(maxNetworkFee, 'exact')} BCH network fee cap + ${formatBch(BUY_PAYOUT_SATS, 'exact')} BCH token dust`}
                </Num>
              </span>
            ) : (
              <Num size="md">
                {`${formatToken(terms.amount, market.decimals, 'exact')} ${market.symbol} and ${formatBch(SELL_ORDER_SATS, 'exact')} BCH reserve`}
              </Num>
            )}
          </Row>
          <Row label="Kept in your wallet">
            <Num>{`At least ${formatFee(FUNDING_MARKER_SATS)} at your owner address.`}</Num> Not a fee: a
            cancel later uses it to prove you own the order.
          </Row>
          <Row label="You receive at least">
            {side === 'buy' ? (
              <TokenAmount
                units={terms.minProceeds}
                decimals={market.decimals}
                symbol={market.symbol}
                mode="exact"
                size="md"
              />
            ) : (
              <BchAmount sats={terms.minProceeds} mode="exact" size="md" />
            )}
          </Row>
          <Row label="Fills when">
            <Num>
              {side === 'buy'
                ? `1 BCH buys ${terms.limitTokensPerBch} ${market.symbol} or more`
                : `${formatToken(terms.amount, market.decimals, 'exact')} ${market.symbol} sells for ${formatBch(terms.minProceeds, 'exact')} BCH or more`}
            </Num>
          </Row>
          <Row label="Network fee">
            <Num>{`up to ${formatFee(maxNetworkFee)}, ${side === 'buy' ? 'taken from the order when it fills' : 'from the pool’s BCH when it fills'}`}</Num>
          </Row>
          <Row label="Cancel">Any time, from your wallet or from Recover</Row>
        </dl>
      )}
    </section>
  );
}
