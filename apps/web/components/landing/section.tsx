import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Home section headings: display-lg from lg, heading-2 below (DD 4 type scale), clear of the header. */
export const SECTION_HEADING = 'scroll-mt-20 font-display text-heading-2 text-fg outline-none lg:text-display-lg';

export const CONTAINER =
  'mx-auto w-full max-w-(--container-app) px-(--space-gutter) md:px-(--space-gutter-md) lg:px-(--space-gutter-lg)';

/**
 * One full-bleed band of the home page. Bands alternate between the canvas and the sunken surface,
 * so a section boundary reads from tone alone, with no rules or shadows (DD 1.5).
 */
export function Band({
  labelledBy,
  tone = 'canvas',
  className,
  children,
}: {
  labelledBy: string;
  tone?: 'canvas' | 'sunken' | 'brand' | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={cn(
        tone === 'sunken' && 'bg-surface-sunken',
        tone === 'brand' && 'bg-brand-subtle',
        'py-(--space-section) lg:py-(--space-section-lg)',
      )}
    >
      <div className={cn(CONTAINER, className)}>{children}</div>
    </section>
  );
}
