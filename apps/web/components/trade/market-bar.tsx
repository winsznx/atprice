'use client';

import type { MarketDefinition } from '@atprice/core';
import { useRouter } from 'next/navigation';
import { HashChip } from '@/components/hash-chip';
import { DisabledReason } from '@/components/states';
import { ToneBadge } from '@/components/status-badge';
import { PairLogos, TokenLogo } from '@/components/token-logo';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Availability, MarketSummary } from '@/lib/api/schemas';
import { formatBch, formatToken } from '@/lib/format';
import { marketSlug, pairText, tradeMarkets } from './market';

const AVAILABILITY: Readonly<
  Record<Availability, { tone: 'filled' | 'pending' | 'cancelled'; label: string }>
> = {
  open: { tone: 'filled', label: 'Orders open' },
  low_liquidity: { tone: 'pending', label: 'Low liquidity' },
  paused: { tone: 'cancelled', label: 'Paused' },
};

export type MarketListView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly markets: readonly MarketSummary[] };

const optionText = (market: MarketDefinition, summary: MarketSummary | undefined): string => {
  if (summary === undefined) return `${pairText(market)}, not listed by AtPrice’s server`;
  const availability = AVAILABILITY[summary.availability].label;
  const liquidity = `${formatToken(summary.liquidity.tokens, market.decimals, 'compact')} ${market.symbol} · ${formatBch(summary.liquidity.sats, 'compact')} BCH`;
  return `${pairText(market)}, ${availability}, ${liquidity}`;
};

/**
 * Market selector and token chip (trade.md "Controls"). Paused markets are listed with their badge
 * and can be viewed. The selector stays focusable with its reason until the list arrives.
 */
export function MarketBar({
  market,
  list,
  availability,
}: {
  market: MarketDefinition;
  list: MarketListView;
  availability: Availability | null;
}) {
  const router = useRouter();
  const reason =
    list.kind === 'loading' ? 'Loading markets.' : list.kind === 'error' ? 'Market list unavailable.' : null;
  const summaries = list.kind === 'ready' ? list.markets : [];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex flex-col gap-1">
        <Select
          value={marketSlug(market)}
          open={reason === null ? undefined : false}
          onValueChange={(slug) => router.push(`/trade/${slug}`)}
        >
          <SelectTrigger
            aria-label={`Market, ${pairText(market)}`}
            aria-disabled={reason === null ? undefined : true}
            aria-describedby={reason === null ? undefined : 'market-select-reason'}
            className="min-w-44 font-display text-heading-3"
          >
            <SelectValue>
              <PairLogos
                tokenCategory={market.tokenCategory}
                symbol={market.symbol}
                size={20}
                className="mr-2 align-middle"
              />
              {pairText(market)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {tradeMarkets().map((option) => (
              <SelectItem key={option.tokenCategory} value={marketSlug(option)}>
                <PairLogos
                  tokenCategory={option.tokenCategory}
                  symbol={option.symbol}
                  className="mr-2 align-middle"
                />
                {optionText(
                  option,
                  summaries.find((summary) => summary.tokenId === option.tokenCategory),
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {reason === null ? null : <DisabledReason id="market-select-reason">{reason}</DisabledReason>}
      </div>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-label text-fg-secondary">
          <TokenLogo asset={market.tokenCategory} symbol={market.symbol} />
          {market.symbol}
        </span>
        <HashChip
          value={market.tokenCategory}
          kind="token"
          label={`${market.symbol} token category ${market.tokenCategory}`}
        />
      </span>
      {availability === 'low_liquidity' ? <ToneBadge tone="pending" label="Low liquidity" /> : null}
      {availability === 'paused' ? <ToneBadge tone="cancelled" label="Paused" /> : null}
    </div>
  );
}
