'use client';

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * M-05 tooltip line: Radix Tooltip content is never `data-state="open"` (it is `delayed-open` or
 * `instant-open`), so the enter is unprefixed and the close rule replaces it. A tooltip never holds
 * information that is not also on the page.
 */
export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={16}
        className={cn(
          'z-(--z-popover) max-w-xs origin-(--radix-tooltip-content-transform-origin) rounded-sm bg-fg px-3 py-2 text-body-sm text-brand-fg shadow-popover',
          'animate-in fade-in-0 ease-enter data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:ease-exit',
          'duration-(--duration-fast) motion-safe:[--tw-enter-scale:0.97] motion-safe:[--tw-exit-scale:0.97]',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
