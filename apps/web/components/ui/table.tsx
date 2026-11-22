import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * DD 7.6: a fixed layout so content wraps inside its column and never widens the table (DD 5.10);
 * header row on sunken, eyebrow style; numbers right-aligned and tabular via `num` on the cell.
 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="w-full overflow-x-auto rounded-lg border border-border">
      <table
        data-slot="table"
        className={cn('w-full table-fixed border-collapse text-body-sm', className)}
        {...props}
      />
    </div>
  );
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption data-slot="table-caption" className={cn('sr-only', className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('bg-surface-sunken', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn('h-14 border-b border-border', className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn('h-10 px-4 text-left align-middle text-eyebrow text-fg-muted uppercase', className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('px-4 py-3 align-middle text-fg', className)} {...props} />;
}
