'use client';

import { XIcon } from '@phosphor-icons/react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

/** M-02 and M-03 share the overlay fade; durations are gated per motion.md rule 8. */
export const OVERLAY_MOTION = cn(
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
  'data-[state=open]:ease-enter data-[state=closed]:ease-exit',
);

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-(--z-overlay) bg-scrim',
        OVERLAY_MOTION,
        'motion-safe:data-[state=open]:duration-(--duration-base) motion-safe:data-[state=closed]:duration-(--duration-fast)',
        'motion-reduce:data-[state=open]:duration-(--duration-fast) motion-reduce:data-[state=closed]:duration-(--duration-fast)',
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  closeLabel = 'Close',
  showClose = true,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  readonly closeLabel?: string | undefined;
  readonly showClose?: boolean | undefined;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-(--z-dialog) flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[27.5rem]',
          '-translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl bg-surface p-6 text-fg shadow-dialog',
          OVERLAY_MOTION,
          'motion-safe:data-[state=open]:duration-(--duration-base) motion-safe:data-[state=closed]:duration-(--duration-fast)',
          'motion-reduce:data-[state=open]:duration-(--duration-fast) motion-reduce:data-[state=closed]:duration-(--duration-fast)',
          'motion-safe:[--tw-enter-scale:0.98] motion-safe:[--tw-enter-translate-y:8px] motion-safe:[--tw-exit-scale:0.98] motion-safe:[--tw-exit-translate-y:8px]',
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'absolute top-3 right-3')}
            aria-label={closeLabel}
          >
            <XIcon aria-hidden="true" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-2 pr-10', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col gap-3 sm:flex-row-reverse', className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-display text-heading-2 text-fg', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-body text-fg-secondary', className)}
      {...props}
    />
  );
}
