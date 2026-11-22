'use client';

import {
  HourglassMediumIcon,
  InfoIcon,
  SealCheckIcon,
  WalletIcon,
  WarningOctagonIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

/** DD 7.13 "Loading": past 8 s a line says the server is slow, with `Retry`. */
export const SLOW_LOADING_MS = 8_000;

export function LoadingRegion({
  thing,
  children,
  onRetry,
  className,
}: {
  /** Fills `Loading {thing}` in the visually hidden status line. */
  thing: string;
  /** Skeleton blocks at the final dimensions. */
  children: ReactNode;
  onRetry?: () => void;
  className?: string | undefined;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_LOADING_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div aria-busy="true" className={className}>
      <p role="status" className="sr-only">
        {`Loading ${thing}`}
      </p>
      {children}
      {slow ? (
        <p className="mt-3 flex flex-wrap items-center gap-3 text-body-sm text-fg-muted">
          Still loading. The server is slow to respond.
          {onRetry === undefined ? null : (
            <Button variant="outline" size="compact" onClick={onRetry}>
              Retry
            </Button>
          )}
        </p>
      ) : null}
    </div>
  );
}

/** DD 12: empty states use a 40px duotone icon, its second layer in the neutral status tint. */
const EMPTY_ICON = 'size-10 text-fg-muted duotone-status-cancelled-subtle';

/** DD 7.13 "Empty": heading-3, one sentence saying why and what to do, one button, a 40px duotone icon (DD 12). */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  headingLevel = 2,
  className,
}: {
  icon: PhosphorIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode | undefined;
  headingLevel?: 2 | 3 | undefined;
  className?: string | undefined;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div
      className={cn('flex flex-col items-start gap-3 rounded-lg border border-border p-5 lg:p-6', className)}
    >
      <Icon aria-hidden="true" weight="duotone" className={EMPTY_ICON} />
      <Heading className="font-display text-heading-3 text-fg">{title}</Heading>
      <p className="max-w-[64ch] text-body text-fg-secondary">{children}</p>
      {action}
    </div>
  );
}

export type AlertTone = 'info' | 'warning' | 'error' | 'success';

const ALERT: Readonly<
  Record<AlertTone, { readonly box: string; readonly icon: PhosphorIcon; readonly iconClass: string }>
> = {
  info: { box: 'bg-surface-sunken', icon: InfoIcon, iconClass: 'text-fg-secondary' },
  warning: { box: 'bg-status-pending-subtle', icon: HourglassMediumIcon, iconClass: 'text-status-pending' },
  error: { box: 'bg-status-failed-subtle', icon: WarningOctagonIcon, iconClass: 'text-status-failed' },
  success: { box: 'bg-status-filled-subtle', icon: SealCheckIcon, iconClass: 'text-status-filled' },
};

/** DD 5.4 severity block: neutral info (never the open blue), pending warning, failed error, filled success. */
export function InlineAlert({
  tone,
  title,
  children,
  icon,
  role,
  className,
}: {
  tone: AlertTone;
  title?: ReactNode | undefined;
  children?: ReactNode | undefined;
  icon?: PhosphorIcon | undefined;
  role?: 'alert' | 'status' | undefined;
  className?: string | undefined;
}) {
  const { box, icon: DefaultIcon, iconClass } = ALERT[tone];
  const Icon = icon ?? DefaultIcon;
  return (
    <div
      role={role}
      className={cn('flex gap-3 rounded-md p-4 text-body-sm text-fg-secondary', box, className)}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', iconClass)} />
      <div className="flex min-w-0 flex-col gap-1">
        {title === undefined ? null : <p className="text-label font-semibold text-fg">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** Errors never disappear on their own; anything touching funds says what still works (DD 7.13). */
export const FUNDS_STILL_SAFE =
  'Your funds stay in their contracts. You can cancel any open order from Recover, which does not use AtPrice’s server.';

export function ErrorState({
  what,
  code,
  stillWorks,
  onRetry,
  retrying = false,
  className,
}: {
  what: string;
  code: string;
  stillWorks?: string | undefined;
  onRetry?: () => void;
  retrying?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <InlineAlert tone="error" role="alert" title={what} className={className}>
      <p className="hash text-mono-sm text-fg">{code}</p>
      {stillWorks === undefined ? null : <p>{stillWorks}</p>}
      {onRetry === undefined ? null : (
        <div className="mt-2">
          <Button variant="outline" size="compact" onClick={onRetry} aria-disabled={retrying || undefined}>
            {retrying ? 'Retrying' : 'Retry'}
          </Button>
        </div>
      )}
    </InlineAlert>
  );
}

/** DD 7.13 "Disconnected (wallet)": public content stays; this panel names what needs a wallet. */
export function DisconnectedPanel({ thing, connectButton }: { thing: string; connectButton: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border p-5 lg:p-6">
      <WalletIcon aria-hidden="true" weight="duotone" className={EMPTY_ICON} />
      <p className="text-body text-fg-secondary">{`Connect a wallet to see ${thing}.`}</p>
      {connectButton}
    </div>
  );
}

/** The visible reason under a disabled control (DD 7 common rules); link it with `aria-describedby`. */
export function DisabledReason({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <p id={id} className={cn('text-body-sm text-fg-muted', className)}>
      {children}
    </p>
  );
}
