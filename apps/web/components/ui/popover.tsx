'use client';

import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

/** M-05 for popover, select and dropdown content: opacity plus a gated 0.97 scale, 150 ms both modes. */
export const FLOATING_MOTION = cn(
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
  'duration-(--duration-fast) data-[state=open]:ease-enter data-[state=closed]:ease-exit',
  'motion-safe:[--tw-enter-scale:0.97] motion-safe:[--tw-exit-scale:0.97]',
);

export function PopoverContent({
  className,
  align = 'center',
  sideOffset = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={16}
        className={cn(
          'z-(--z-popover) w-max max-w-[calc(100vw-2rem)] origin-(--radix-popover-content-transform-origin) rounded-lg border border-border bg-surface p-4 text-fg shadow-popover',
          FLOATING_MOTION,
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
