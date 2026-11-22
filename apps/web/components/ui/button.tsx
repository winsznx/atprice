import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps, MouseEvent } from 'react';
import { cn } from '@/lib/utils';

/** M-01: colour properties only, so the focus outline (instant, DD 5.2) is never transitioned. */
export const CONTROL_TRANSITION =
  'transition-[color,background-color,border-color,text-decoration-color] duration-(--duration-fast) ease-move';

export const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-sans text-body font-semibold whitespace-nowrap select-none',
    '[&_svg]:pointer-events-none [&_svg]:size-5 [&_svg]:shrink-0',
    CONTROL_TRANSITION,
    'aria-disabled:cursor-not-allowed aria-disabled:bg-surface-muted aria-disabled:text-fg-disabled aria-disabled:shadow-none',
    'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-fg-disabled disabled:shadow-none',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-brand text-brand-fg shadow-inset hover:bg-brand-hover active:bg-brand-hover',
        dark: 'bg-fg text-brand-fg shadow-inset hover:bg-fg-hover active:bg-fg-hover',
        outline:
          'border border-border-input bg-surface text-fg hover:bg-surface-sunken active:bg-surface-sunken',
        ghost: 'text-fg-secondary hover:bg-surface-sunken active:bg-surface-sunken',
        destructive:
          'bg-status-failed text-brand-fg shadow-inset hover:bg-status-failed-hover active:bg-status-failed-hover',
        // A text link wraps like the sentence it sits in, so a long one never pushes the page sideways at 320px.
        link: 'h-auto min-h-0 px-0 text-left whitespace-normal text-link underline-offset-4 hover:underline',
      },
      size: {
        default: 'min-h-(--size-control) px-5',
        compact: 'min-h-10 px-4 text-label font-semibold',
        trade: 'min-h-(--size-control-lg) px-6',
        icon: 'size-(--size-control) p-0',
        'icon-sm': 'size-(--size-control-sm) p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean | undefined;
}

/**
 * DD 7.1. A control that must stay reachable with its reason uses `aria-disabled` (not `disabled`)
 * and `aria-describedby` pointing at the visible reason; clicks are swallowed here so callers can't
 * forget. The attribute applies in the same frame; only the colour takes 150 ms (M-01 note).
 */
export function Button({ className, variant, size, asChild = false, onClick, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  const ariaDisabled = props['aria-disabled'] === true || props['aria-disabled'] === 'true';
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (ariaDisabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      onClick={handleClick}
      {...(asChild ? {} : { type: props.type ?? 'button' })}
      {...props}
    />
  );
}
