import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** DD 7.13: static block at the final dimensions, no shimmer (motion.md rule 3). */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('rounded-sm bg-surface-muted', className)}
      {...props}
    />
  );
}
