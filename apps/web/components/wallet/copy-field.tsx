'use client';

import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { useCopy } from '../hash-chip';
import { Button, CONTROL_TRANSITION } from '../ui/button';

/** A copyable mono value that is not a chain object (the WizardConnect URI): copy only, no explorer. */
export function CopyField({
  value,
  shown,
  copyLabel,
  buttonText,
  className,
}: {
  value: string;
  shown: string;
  copyLabel: string;
  /** When set, a visible text button (`Copy link`) replaces the icon button. */
  buttonText?: string | undefined;
  className?: string | undefined;
}) {
  const { state, copy } = useCopy(value);
  const textRef = useRef<HTMLSpanElement>(null);
  const onCopy = async () => {
    if (await copy()) return;
    requestAnimationFrame(() => {
      const element = textRef.current;
      if (element === null) return;
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
  };
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex min-h-8 max-w-full items-center gap-1 rounded-sm bg-surface-sunken pl-2 text-mono-sm text-fg">
        <span
          ref={textRef}
          className={cn('hash min-w-0 py-1', state === 'failed' ? 'break-all' : 'truncate')}
        >
          {state === 'failed' ? value : shown}
        </span>
        {buttonText === undefined ? (
          <button
            type="button"
            onClick={onCopy}
            aria-label={copyLabel}
            className={cn(
              'relative inline-flex size-9 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-muted hover:text-fg',
              CONTROL_TRANSITION,
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
        ) : null}
      </div>
      {buttonText === undefined ? null : (
        <Button variant="outline" onClick={onCopy} aria-label={copyLabel}>
          {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {buttonText}
        </Button>
      )}
      <span
        role="status"
        aria-live="polite"
        className={state === 'failed' ? 'text-body-sm text-status-failed' : 'sr-only'}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Select the text instead.' : ''}
      </span>
    </div>
  );
}
