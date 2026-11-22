'use client';

import {
  CircleIcon,
  CrosshairIcon,
  GitDiffIcon,
  HourglassMediumIcon,
  ProhibitInsetIcon,
  SealCheckIcon,
  WarningOctagonIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';
import type { StepState, StepTone, TimelineStep } from '@/lib/orders/timeline';
import { cn } from '@/lib/utils';
import { HashChip } from './hash-chip';
import { LocalTime } from './local-time';

const ICON: Readonly<Record<StepTone, PhosphorIcon>> = {
  pending: HourglassMediumIcon,
  open: CrosshairIcon,
  filled: SealCheckIcon,
  cancelled: ProhibitInsetIcon,
  failed: WarningOctagonIcon,
  review: GitDiffIcon,
  upcoming: CircleIcon,
};

/** DD 12: the duotone second layer takes the step's status tint; an upcoming step is neutral. */
const TINT: Readonly<Record<StepTone, string>> = {
  pending: 'duotone-status-pending-subtle',
  open: 'duotone-status-open-subtle',
  filled: 'duotone-status-filled-subtle',
  cancelled: 'duotone-status-cancelled-subtle',
  failed: 'duotone-status-failed-subtle',
  review: 'duotone-status-review-subtle',
  upcoming: 'duotone-status-cancelled-subtle',
};

const COLOUR: Readonly<Record<StepTone, string>> = {
  pending: 'text-status-pending',
  open: 'text-status-open',
  filled: 'text-status-filled',
  cancelled: 'text-status-cancelled',
  failed: 'text-status-failed',
  review: 'text-status-review',
  upcoming: 'text-border-input',
};

const RING: Readonly<Record<StepTone, string>> = {
  pending: 'ring-status-pending',
  open: 'ring-status-open',
  filled: 'ring-status-filled',
  cancelled: 'ring-status-cancelled',
  failed: 'ring-status-failed',
  review: 'ring-status-review',
  upcoming: 'ring-transparent',
};

/** M-08: failures and reviews swap instantly; other observed changes cross-fade; nothing plays on load. */
const advanceClass = (previous: StepState | undefined, next: StepState): string => {
  if (previous === undefined || previous === next) return '';
  if (next === 'failed' || next === 'review') return '';
  return 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-(--duration-base) ease-move';
};

/**
 * DD 7.5 order status timeline, an `<ol>` whose items carry their state in the accessible name. The
 * caller passes steps from `timelineSteps(order)`; a new poll result re-renders it, and only the
 * steps whose state changed while the page was open animate (M-08).
 */
export function OrderTimeline({
  steps,
  label,
  className,
}: {
  steps: readonly TimelineStep[];
  /** Accessible name of the list (`Order timeline` on the order page). */
  label?: string | undefined;
  className?: string | undefined;
}) {
  const signature = steps.map((step) => `${step.id}=${step.state}`).join('|');
  const [seen, setSeen] = useState<{
    readonly signature: string;
    readonly states: ReadonlyMap<string, StepState>;
    readonly before: ReadonlyMap<string, StepState> | null;
  }>(() => ({ signature, states: new Map(steps.map((step) => [step.id, step.state])), before: null }));
  if (seen.signature !== signature) {
    // React's "adjust state when a prop changes" pattern: remember what was on screen before this poll.
    setSeen({ signature, states: new Map(steps.map((step) => [step.id, step.state])), before: seen.states });
  }
  const before = seen.signature === signature ? seen.before : seen.states;

  return (
    <ol aria-label={label} className={cn('flex flex-col', className)}>
      {steps.map((step, index) => {
        const Icon = ICON[step.tone];
        const last = index === steps.length - 1;
        const prior = before?.get(step.id);
        const connectorFilled = step.state !== 'upcoming';
        return (
          <li
            key={step.id}
            aria-label={`Step ${index + 1} of ${steps.length}, ${step.spoken}`}
            className="relative flex gap-3 pb-6 last:pb-0"
          >
            {last ? null : (
              <span aria-hidden="true" className="absolute top-7 bottom-1 left-[11px] w-0.5 bg-border">
                <span
                  className={cn(
                    'absolute inset-0 origin-top bg-border-strong motion-safe:transition-transform motion-safe:duration-(--duration-slow) ease-move',
                    connectorFilled && steps[index + 1]?.state !== 'upcoming' ? 'scale-y-100' : 'scale-y-0',
                  )}
                />
              </span>
            )}
            <span
              aria-hidden="true"
              key={`${step.id}-${step.state}`}
              className={cn(
                'relative z-(--z-base) mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface',
                step.state === 'current' && cn('ring-2', RING[step.tone]),
                advanceClass(before === null ? undefined : (prior ?? 'upcoming'), step.state),
              )}
            >
              <Icon weight="duotone" className={cn('size-6', COLOUR[step.tone], TINT[step.tone])} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className={cn('text-label', step.state === 'upcoming' ? 'text-fg-muted' : 'text-fg')}>
                {step.label}
              </span>
              {step.meta === null && step.at === null ? null : (
                <span className="text-caption text-fg-muted">
                  {step.at === null ? null : <LocalTime iso={step.at} />}
                  {step.at !== null && step.meta !== null ? ', ' : null}
                  {step.meta === null ? null : <span className="num">{step.meta}</span>}
                </span>
              )}
              {step.txid === null ? null : <HashChip value={step.txid} kind="tx" />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
