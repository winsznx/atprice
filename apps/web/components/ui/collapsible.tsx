'use client';

import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

/**
 * M-07: the content is the grid container animated with the `disclosure-*` keyframes from globals.css;
 * Radix Presence waits for `animationend` to set `hidden`. Under reduced motion no animation class
 * exists, so it opens and closes in one frame.
 */
export function CollapsibleContent({
  className,
  children,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.Content>) {
  return (
    <CollapsiblePrimitive.Content
      data-slot="collapsible-content"
      className={cn(
        'grid',
        'motion-safe:data-[state=open]:animate-[disclosure-open_var(--duration-base)_var(--ease-move)]',
        'motion-safe:data-[state=closed]:animate-[disclosure-close_var(--duration-base)_var(--ease-move)]',
        className,
      )}
      {...props}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </CollapsiblePrimitive.Content>
  );
}
