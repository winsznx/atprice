'use client';

import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { CONTROL_TRANSITION } from './button';

export const Tabs = TabsPrimitive.Root;

/** DD 7.15 segmented tabs: Radix arrow-key navigation, counts in the label (`Open 2`). */
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'inline-flex min-h-(--size-control) items-center gap-1 rounded-md bg-surface-muted p-1',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'num inline-flex min-h-9 items-center justify-center gap-2 rounded-sm px-3 text-label text-fg-muted',
        'hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:font-semibold',
        CONTROL_TRANSITION,
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content data-slot="tabs-content" className={cn('outline-none', className)} {...props} />
  );
}
