import type { OrderStatus } from '@atprice/core';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import {
  ArrowCircleDownLeftIcon,
  ArrowCircleUpRightIcon,
  CrosshairIcon,
  FlaskIcon,
  GitDiffIcon,
  HourglassMediumIcon,
  ProhibitInsetIcon,
  SealCheckIcon,
  WarningOctagonIcon,
} from '@phosphor-icons/react/dist/ssr';
import { appNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';

export type StatusTone = 'open' | 'pending' | 'filled' | 'cancelled' | 'failed' | 'review';

const TONE: Readonly<
  Record<StatusTone, { readonly className: string; readonly tint: string; readonly icon: PhosphorIcon }>
> = {
  open: {
    className: 'bg-status-open-subtle text-status-open',
    tint: 'duotone-status-open-subtle',
    icon: CrosshairIcon,
  },
  pending: {
    className: 'bg-status-pending-subtle text-status-pending',
    tint: 'duotone-status-pending-subtle',
    icon: HourglassMediumIcon,
  },
  filled: {
    className: 'bg-status-filled-subtle text-status-filled',
    tint: 'duotone-status-filled-subtle',
    icon: SealCheckIcon,
  },
  cancelled: {
    className: 'bg-status-cancelled-subtle text-status-cancelled',
    tint: 'duotone-status-cancelled-subtle',
    icon: ProhibitInsetIcon,
  },
  failed: {
    className: 'bg-status-failed-subtle text-status-failed',
    tint: 'duotone-status-failed-subtle',
    icon: WarningOctagonIcon,
  },
  review: {
    className: 'bg-status-review-subtle text-status-review',
    tint: 'duotone-status-review-subtle',
    icon: GitDiffIcon,
  },
};

/** Browser-side states that never reach the server (PRD 14.1); DRAFT has no badge. */
export type BadgeStatus = OrderStatus | 'AWAITING_SIGNATURE' | 'FAILED';

/** DD 5.4 mapping from PRD 14 states to tone and label. */
export const STATUS_DISPLAY: Readonly<
  Record<BadgeStatus, { readonly tone: StatusTone; readonly label: string }>
> = {
  AWAITING_SIGNATURE: { tone: 'pending', label: 'Awaiting signature' },
  FUNDING_PENDING: { tone: 'pending', label: 'Funding pending' },
  OPEN: { tone: 'open', label: 'Open' },
  EXECUTION_PENDING: { tone: 'pending', label: 'Execution pending' },
  CANCELLATION_PENDING: { tone: 'pending', label: 'Cancel pending' },
  FILLED: { tone: 'filled', label: 'Filled' },
  CANCELLED: { tone: 'cancelled', label: 'Cancelled' },
  RECONCILIATION_REQUIRED: { tone: 'review', label: 'Needs review' },
  FAILED: { tone: 'failed', label: 'Failed' },
};

const PILL =
  'inline-flex min-h-6 items-center gap-1 rounded-full px-2 text-caption font-semibold whitespace-nowrap';

/**
 * DD 7.15 status badge: tint, icon and word, so it reads without colour. It is text, not a control.
 * `icon` replaces the tone's own icon where DD 7.6 names a different one (`Warning` on a
 * pending-toned `Low liquidity`).
 */
export function ToneBadge({
  tone,
  label,
  icon,
  className,
}: {
  tone: StatusTone;
  label: string;
  icon?: PhosphorIcon | undefined;
  className?: string | undefined;
}) {
  const { className: toneClass, tint, icon: toneIcon } = TONE[tone];
  const Icon = icon ?? toneIcon;
  return (
    <span className={cn(PILL, toneClass, className)}>
      <Icon aria-hidden="true" weight="duotone" className={cn('size-4', tint)} />
      {label}
    </span>
  );
}

export function StatusBadge({ status, className }: { status: BadgeStatus; className?: string | undefined }) {
  const { tone, label } = STATUS_DISPLAY[status];
  return <ToneBadge tone={tone} label={label} className={className} />;
}

/** `ArrowCircleDownLeft` buy (tokens come in), `ArrowCircleUpRight` sell (tokens go out), DD 5.3 and DD 12. */
export function SideBadge({ side, className }: { side: 'buy' | 'sell'; className?: string | undefined }) {
  const Icon = side === 'buy' ? ArrowCircleDownLeftIcon : ArrowCircleUpRightIcon;
  return (
    <span
      className={cn(PILL, side === 'buy' ? 'bg-buy-subtle text-buy' : 'bg-sell-subtle text-sell', className)}
    >
      <Icon
        aria-hidden="true"
        weight="duotone"
        className={cn('size-4', side === 'buy' ? 'duotone-buy-subtle' : 'duotone-sell-subtle')}
      />
      {side === 'buy' ? 'Buy' : 'Sell'}
    </span>
  );
}

/** Header network badge, always visible (DD 7.15). */
export function NetworkBadge({ className }: { className?: string | undefined }) {
  return appNetwork.network === 'mainnet' ? (
    <ToneBadge tone="cancelled" label="Mainnet" className={className} />
  ) : (
    <span className={cn(PILL, 'bg-status-pending-subtle text-status-pending', className)}>
      <FlaskIcon aria-hidden="true" weight="duotone" className="size-4 duotone-status-pending-subtle" />
      Chipnet: test coins
    </span>
  );
}

/** DD 7.13 stale data: values stay visible, this badge and the age say they are old. */
export function StaleBadge({ age, className }: { age?: string | undefined; className?: string | undefined }) {
  return (
    <ToneBadge
      tone="pending"
      label={age === undefined ? 'Stale' : `Stale, ${age} old`}
      className={className}
    />
  );
}
