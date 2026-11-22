'use client';

import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { truncateMiddle } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ExplorerLink, type ExplorerKind } from './explorer-link';
import { CONTROL_TRANSITION } from './ui/button';

export type HashKind = 'tx' | 'address' | 'token' | 'outpoint' | 'keyhash';

const NOUN: Readonly<Record<HashKind, string>> = {
  tx: 'transaction id',
  address: 'address',
  token: 'token category',
  outpoint: 'outpoint',
  keyhash: 'key hash',
};

const COPIED_HOLD_MS = 1_500;

const explorerTarget = (kind: HashKind, value: string): { kind: ExplorerKind; value: string } | null => {
  switch (kind) {
    case 'tx':
      return { kind: 'tx', value };
    case 'address':
      return { kind: 'address', value };
    case 'token':
      return { kind: 'token', value };
    case 'outpoint':
      return { kind: 'tx', value: value.split(':')[0] ?? value };
    case 'keyhash':
      return null;
  }
};

type CopyState = 'idle' | 'copied' | 'failed';

/** Copies `value`, holds the Check icon 1.5 s (M-09), and reports failure honestly (DD 7.11). */
export function useCopy(value: string): { state: CopyState; copy: () => Promise<boolean> } {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (): Promise<boolean> => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), COPIED_HOLD_MS);
      return true;
    } catch (error) {
      console.warn('Clipboard write failed:', error);
      setState('failed');
      return false;
    }
  };
  return { state, copy };
}

const selectText = (element: HTMLElement | null): void => {
  if (element === null) return;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
};

/**
 * DD 7.11 `<HashChip>`: mono on sunken, middle truncation (first 8, last 6, prefix dropped in the chip
 * but kept in the copied value), copy button and, except for key hashes, an explorer link.
 * `inverse` is the banner's chip (DD 5.5). `full` wraps the whole value (receipts, Recover).
 */
export function HashChip({
  value,
  kind,
  full = false,
  inverse = false,
  label,
  copyLabel,
  trailing,
  className,
}: {
  value: string;
  kind: HashKind;
  full?: boolean | undefined;
  inverse?: boolean | undefined;
  /** Accessible name of the chip group, when the context needs more than the noun. */
  label?: string | undefined;
  /** Accessible name of the copy button, when a list needs the role in it (`Funding transaction 3f9a…c21d, copy`). */
  copyLabel?: string | undefined;
  /** Extra controls inside the chip (the banner's `Show QR`). */
  trailing?: ReactNode | undefined;
  className?: string | undefined;
}) {
  const { state, copy } = useCopy(value);
  const textRef = useRef<HTMLSpanElement>(null);
  const target = explorerTarget(kind, value);
  const noun = NOUN[kind];
  const shown = full || state === 'failed' ? value : truncateMiddle(value);

  const onCopy = async () => {
    // The failed state renders the full value; select it once that render has landed.
    if (!(await copy())) requestAnimationFrame(() => selectText(textRef.current));
  };

  return (
    <span className={cn('inline-flex max-w-full flex-col gap-1', className)}>
      <span
        role="group"
        aria-label={label ?? `${noun} ${value}`}
        className={cn(
          'inline-flex max-w-full min-h-8 items-center gap-1 rounded-sm pl-2 text-mono-sm',
          inverse
            ? 'border border-banner-chip-border bg-banner-chip text-banner-chip-fg'
            : 'bg-surface-sunken text-fg',
        )}
      >
        <span
          ref={textRef}
          className={cn('hash py-1', full || state === 'failed' ? 'whitespace-normal' : 'whitespace-nowrap')}
          title={full ? undefined : value}
        >
          {shown}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copyLabel ?? `Copy ${noun}`}
          className={cn(
            'relative inline-flex size-9 shrink-0 items-center justify-center rounded-sm',
            CONTROL_TRANSITION,
            inverse
              ? 'text-banner-fg-muted hover:bg-banner-chip-hover'
              : 'text-fg-muted hover:bg-surface-muted hover:text-fg',
          )}
        >
          <CopyIcon
            aria-hidden="true"
            className={cn(
              'absolute size-4 motion-safe:transition-opacity motion-safe:duration-(--duration-fast) ease-move',
              state === 'copied' ? 'opacity-0' : 'opacity-100',
            )}
          />
          <CheckIcon
            aria-hidden="true"
            className={cn(
              'absolute size-4 motion-safe:transition-opacity motion-safe:duration-(--duration-fast) ease-move',
              state === 'copied' ? 'opacity-100' : 'opacity-0',
            )}
          />
        </button>
        {target === null || inverse ? null : (
          <ExplorerLink kind={target.kind} value={target.value} iconOnly />
        )}
        {trailing}
      </span>
      <span
        role="status"
        aria-live="polite"
        className={cn(state === 'failed' ? 'text-body-sm text-status-failed' : 'sr-only')}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Select the text instead.' : ''}
      </span>
    </span>
  );
}
