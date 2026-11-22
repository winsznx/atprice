import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { MinusIcon, TrendDownIcon, TrendUpIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';
import { Rate } from '@/components/amount';
import { ToneBadge, type StatusTone } from '@/components/status-badge';
import type { Availability, MarketSummary } from '@/lib/api/schemas';
import { formatBch } from '@/lib/format';
import { cn } from '@/lib/utils';
import { changeOf, shortSymbol, tokensPerBch, type AvailabilityDisplay } from './market-logic';

/** DD 7.6: `CircleCheck` open, `TriangleAlert` low liquidity, `CircleSlash` paused. */
const AVAILABILITY_TONE: Readonly<Record<Availability, { readonly tone: StatusTone; readonly icon?: PhosphorIcon }>> = {
  open: { tone: 'filled' },
  low_liquidity: { tone: 'pending', icon: WarningIcon },
  paused: { tone: 'cancelled' },
};

export function AvailabilityBadge({
  display,
  className,
}: {
  display: AvailabilityDisplay;
  className?: string | undefined;
}) {
  const { tone, icon } = AVAILABILITY_TONE[display.availability];
  return <ToneBadge tone={tone} label={display.label} icon={icon} className={className} />;
}

/** The paused reason as plain text after the badge (DD 7.6); other states carry none. */
export function AvailabilityReason({
  display,
  className,
}: {
  display: AvailabilityDisplay;
  className?: string | undefined;
}) {
  if (display.availability !== 'paused' || display.reason === null) return null;
  return <p className={cn('text-body-sm text-fg-muted', className)}>{`Paused: ${display.reason}`}</p>;
}

const DIRECTION_ICON: Readonly<Record<'up' | 'down' | 'flat', PhosphorIcon>> = {
  up: TrendUpIcon,
  down: TrendDownIcon,
  flat: MinusIcon,
};

export function ChangeValue({
  change,
  className,
}: {
  change: MarketSummary['change24h'];
  className?: string | undefined;
}) {
  const display = changeOf(change);
  if (display.direction === 'none') {
    return (
      <span className={cn('text-body-sm text-fg-muted', className)}>
        <span aria-hidden="true">{display.text}</span>
        <span className="sr-only">{display.spoken}</span>
      </span>
    );
  }
  const Icon = DIRECTION_ICON[display.direction];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 num whitespace-nowrap',
        display.direction === 'up' ? 'text-buy' : display.direction === 'down' ? 'text-sell' : 'text-fg-secondary',
        className,
      )}
    >
      <span aria-hidden="true">{display.text}</span>
      <Icon aria-hidden="true" className="size-4" />
      <span className="sr-only">{display.spoken}</span>
    </span>
  );
}

/** Spot rate `452.10 PUSD per BCH`; a market observation, so no `≈` (DD 4 "Rates"). */
export function SpotRate({
  market,
  size,
  className,
}: {
  market: Pick<MarketSummary, 'spotRate' | 'decimals' | 'symbol'>;
  size?: 'xl' | 'md' | 'sm' | undefined;
  className?: string | undefined;
}) {
  const rate = tokensPerBch(market.spotRate, market.decimals);
  if (rate === null) {
    return (
      <NotAvailable
        reason={market.spotRate.reason ?? 'no pool rate observed'}
        what="Rate"
        className={className}
      />
    );
  }
  return (
    <Rate
      numerator={rate.numerator}
      denominator={rate.denominator}
      unit={`${shortSymbol(market.symbol)} per BCH`}
      size={size}
      className={className}
    />
  );
}

/** DD 7.6: missing data reads `Not available`, with the reason in the accessible name, never `0`. */
export function NotAvailable({
  what,
  reason,
  className,
}: {
  what: string;
  reason: string;
  className?: string | undefined;
}) {
  return (
    <span className={cn('text-body-sm text-fg-muted', className)}>
      <span aria-hidden="true">Not available</span>
      <span className="sr-only">{`${what} not available: ${reason}`}</span>
    </span>
  );
}

export function VolumeValue({ market }: { market: Pick<MarketSummary, 'volume24h'> }) {
  const volume = market.volume24h;
  if (volume.value === null) return <NotAvailable what="24 hour volume" reason={volume.reason} />;
  return <span className="num">{`${formatBch(volume.value.sats, 'compact')} BCH`}</span>;
}
