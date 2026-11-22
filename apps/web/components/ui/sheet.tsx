'use client';

import { XIcon } from '@phosphor-icons/react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button';
import { OVERLAY_MOTION } from './dialog';

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

const SHEET_DURATIONS = cn(
  'motion-safe:data-[state=open]:duration-(--duration-slow) motion-safe:data-[state=closed]:duration-(--duration-base)',
  'motion-reduce:data-[state=open]:duration-(--duration-fast) motion-reduce:data-[state=closed]:duration-(--duration-fast)',
);

const SIDES = {
  bottom: cn(
    'inset-x-0 bottom-0 max-h-[calc(100dvh-2rem)] rounded-t-xl',
    'motion-safe:data-[state=open]:slide-in-from-bottom motion-safe:data-[state=closed]:slide-out-to-bottom',
  ),
  right: cn(
    'inset-y-0 right-0 h-full w-full max-w-[25rem] border-l border-border',
    'motion-safe:data-[state=open]:slide-in-from-right motion-safe:data-[state=closed]:slide-out-to-right',
  ),
} as const;

/** M-03. No swipe or drag: sheets close with the close button, Escape or the scrim. */
export function SheetContent({
  className,
  children,
  side = 'bottom',
  closeLabel = 'Close',
  showClose = true,
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & {
  readonly side?: keyof typeof SIDES | undefined;
  readonly closeLabel?: string | undefined;
  readonly showClose?: boolean | undefined;
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        className={cn('fixed inset-0 z-(--z-overlay) bg-scrim', OVERLAY_MOTION, SHEET_DURATIONS)}
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed z-(--z-dialog) flex flex-col gap-4 overflow-y-auto bg-surface p-5 text-fg shadow-dialog lg:p-6',
          'pb-[calc(1.25rem+env(safe-area-inset-bottom))]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:ease-enter data-[state=closed]:ease-exit',
          'motion-reduce:data-[state=open]:fade-in-0 motion-reduce:data-[state=closed]:fade-out-0',
          SHEET_DURATIONS,
          SIDES[side],
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <SheetPrimitive.Close
            className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'absolute top-3 right-3')}
            aria-label={closeLabel}
          >
            <XIcon aria-hidden="true" />
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-2 pr-10', className)} {...props} />;
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-display text-heading-2 text-fg', className)}
      {...props}
    />
  );
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-body text-fg-secondary', className)}
      {...props}
    />
  );
}
