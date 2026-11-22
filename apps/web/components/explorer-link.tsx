import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';
import { appNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { CONTROL_TRANSITION, buttonVariants } from './ui/button';

export type ExplorerKind = 'tx' | 'address' | 'token';

const NOUN: Readonly<Record<ExplorerKind, string>> = {
  tx: 'transaction',
  address: 'address',
  token: 'token',
};

/** The explorer URL for a value on this build's network, or null where no verified explorer exists. */
export const explorerUrl = (kind: ExplorerKind, value: string): string | null => {
  const explorer = appNetwork.explorer;
  switch (kind) {
    case 'tx':
      return explorer.tx(value);
    case 'address':
      return explorer.address(value);
    case 'token':
      return explorer.token === null ? null : explorer.token(value);
  }
};

/**
 * DD 7.12: built from network config, opens in a new tab, and its accessible name ends with
 * "opens in a new tab". On chipnet the name says "chipnet explorer".
 */
export function ExplorerLink({
  kind,
  value,
  children,
  iconOnly = false,
  className,
}: {
  kind: ExplorerKind;
  value: string;
  children?: ReactNode | undefined;
  iconOnly?: boolean | undefined;
  className?: string | undefined;
}) {
  const href = explorerUrl(kind, value);
  if (href === null) return null;
  const label = `Open ${NOUN[kind]} in ${appNetwork.explorer.label}, opens in a new tab`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={iconOnly ? label : undefined}
      className={cn(
        iconOnly
          ? cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'text-fg-muted hover:text-fg')
          : cn('inline-flex items-center gap-1 text-link underline underline-offset-4', CONTROL_TRANSITION),
        className,
      )}
    >
      {iconOnly ? null : children}
      {iconOnly ? null : <span className="sr-only">, opens in a new tab</span>}
      <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
    </a>
  );
}
