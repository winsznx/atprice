import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge must know the DD 4 type scale: otherwise it reads `text-label` as a colour and drops
 * a `text-brand-fg` next to it (or the reverse), and a button label silently loses its colour.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        'display-lg',
        'heading-1',
        'heading-2',
        'heading-3',
        'lead',
        'body',
        'body-sm',
        'label',
        'caption',
        'eyebrow',
        'num-xl',
        'num-lg',
        'num-md',
        'num-sm',
        'mono-md',
        'mono-sm',
      ],
    },
  },
});

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
