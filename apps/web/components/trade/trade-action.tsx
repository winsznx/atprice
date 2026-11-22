'use client';

import { WarningOctagonIcon } from '@phosphor-icons/react';
import { useId, type ReactNode, type Ref } from 'react';
import { DisabledReason, InlineAlert } from '@/components/states';
import { Button } from '@/components/ui/button';
import { formatElapsed } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useThrottledText } from './hooks';

/** What `Review order` is doing after a click (DD 7.2 steps a to d). */
export type CheckState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking'; readonly since: number }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unanswered'; readonly code: string }
  /** A message above the button with focus on it (owner changed, restore blocked, draft gone). */
  | { readonly kind: 'notice'; readonly text: string };

export interface MinimumLine {
  /** `230.00 PUSD` or `2.50000000 BCH`, exact. Null until amount and limit are valid. */
  readonly value: string | null;
  readonly explanation: string | null;
  /** DD 4.1 sell payout line. */
  readonly payout: string | null;
}

/** Below 2 s the button just reads `Checking order`; after that the elapsed time shows. */
const ELAPSED_AFTER_MS = 2_000;

/**
 * The min-received line and the primary button: one `<button>` with a stable identity from `Connect
 * wallet` to `Review order`, so focus returns to it after connecting (DD 7.8). It renders in the
 * ticket from lg, in the sticky bar below lg, or inline after the fee row while the keyboard is open
 * or under the short rule; the caller decides the one place.
 */
export function TradeAction({
  placement,
  minimum,
  label,
  reason,
  busy,
  checkElapsedMs,
  check,
  onClick,
  onTryAgain,
  buttonRef,
  noticeRef,
  mismatchRef,
}: {
  placement: 'ticket' | 'inline' | 'bar';
  minimum: MinimumLine;
  label: 'Connect wallet' | 'Review order' | 'Checking order';
  /** Shown under the button; `blocks` false for the reason printed under an enabled `Connect wallet`. */
  reason: { readonly text: string; readonly blocks: boolean } | null;
  busy: boolean;
  checkElapsedMs: number | null;
  check: CheckState;
  onClick: () => void;
  onTryAgain: () => void;
  buttonRef: Ref<HTMLButtonElement>;
  noticeRef: Ref<HTMLParagraphElement>;
  mismatchRef: Ref<HTMLHeadingElement>;
}) {
  const reasonId = useId();
  const minimumText =
    minimum.value === null
      ? 'You receive at least: enter an amount and a limit price'
      : `You receive at least ${minimum.value}`;
  const announced = useThrottledText(minimumText, 2_000);
  const inBar = placement === 'bar';
  const buttonText =
    label === 'Checking order' && checkElapsedMs !== null && checkElapsedMs >= ELAPSED_AFTER_MS
      ? `Checking order · ${formatElapsed(checkElapsedMs)}`
      : label;

  let feedback: ReactNode = null;
  switch (check.kind) {
    case 'mismatch':
      feedback = (
        <InlineAlert
          tone="error"
          role="alert"
          title={
            <span ref={mismatchRef} tabIndex={-1} className="outline-offset-2">
              Contract address mismatch
            </span>
          }
        >
          <p>
            AtPrice’s server derived a different contract address for these terms. Nothing was sent to your
            wallet. Code: <span className="hash text-mono-sm text-fg">INTENT_MISMATCH</span>.
          </p>
          <div className="mt-2">
            <Button variant="outline" size="compact" onClick={onTryAgain}>
              Try again
            </Button>
          </div>
        </InlineAlert>
      );
      break;
    case 'notice':
      feedback = (
        <p ref={noticeRef} tabIndex={-1} className="rounded-md bg-surface-sunken p-3 text-body-sm text-fg">
          {check.text}
        </p>
      );
      break;
    default:
      break;
  }

  let inlineError: ReactNode = null;
  if (check.kind === 'rejected') {
    inlineError = (
      <p role="alert" className="flex items-start gap-1 text-body-sm text-status-failed">
        <WarningOctagonIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="hash text-mono-sm">{check.code}</span>: {check.message}
        </span>
      </p>
    );
  } else if (check.kind === 'unanswered') {
    inlineError = (
      <div role="alert" className="flex flex-col items-start gap-2 text-body-sm text-status-failed">
        <p className="flex items-start gap-1">
          <WarningOctagonIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            AtPrice’s server didn’t answer the order check (
            <span className="hash text-mono-sm">{check.code}</span>). Nothing was sent to your wallet.
          </span>
        </p>
        <Button variant="outline" size="compact" onClick={onTryAgain}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', inBar && 'gap-2')}>
      <div className="flex min-w-0 flex-col gap-1">
        <output aria-live="polite" aria-atomic="true" className="sr-only">
          {announced}
        </output>
        <div aria-hidden="true" className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-label text-fg-secondary">You receive at least</span>
          <span className={cn('num text-fg', inBar ? 'text-num-md' : 'text-num-lg')}>
            {minimum.value ?? 'Enter an amount and a limit'}
          </span>
        </div>
        {inBar || minimum.payout === null ? null : (
          <p className="num text-body-sm text-fg-secondary">{minimum.payout}</p>
        )}
        {inBar || minimum.explanation === null ? null : (
          <p className="text-body-sm text-fg-muted">{minimum.explanation}</p>
        )}
      </div>
      {feedback}
      <Button
        key="trade-primary"
        ref={buttonRef}
        size="trade"
        className="w-full whitespace-normal"
        onClick={onClick}
        aria-busy={busy || undefined}
        aria-disabled={reason?.blocks === true || busy || undefined}
        aria-describedby={reason === null ? undefined : reasonId}
      >
        <span className="num">{buttonText}</span>
      </Button>
      {reason === null ? null : <DisabledReason id={reasonId}>{reason.text}</DisabledReason>}
      {inlineError}
    </div>
  );
}
