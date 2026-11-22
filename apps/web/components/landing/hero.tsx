import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HeroReceipt } from './hero-receipt';
import { LineMotif } from './line-motif';
import { CONTAINER } from './section';

/** The first child of `<main>`: the page's `<h1>`, one sentence, the two actions, and the latest real fill. */
export function Hero() {
  return (
    <div
      className={cn(
        CONTAINER,
        'grid gap-10 pt-10 pb-(--space-section) md:pt-14 lg:min-h-[calc(100svh-var(--size-header)-var(--size-banner))] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center lg:gap-16 lg:py-16',
      )}
    >
      <div className="flex flex-col items-start gap-6 lg:gap-8">
        <h1 className="max-w-[14ch] font-display text-heading-1 text-balance text-fg xs:text-display-lg lg:text-hero">
          Set your price. Trade when the market meets it.
        </h1>
        <p className="max-w-[52ch] text-body text-fg-secondary lg:text-lead">
          Place a limit order for a CashToken on Bitcoin Cash, and it fills through a Cauldron pool once the
          market reaches your price, whether or not you are online.
        </p>
        <div className="flex w-full flex-col gap-3 xs:w-auto xs:flex-row xs:flex-wrap">
          <Link href="/trade" className={buttonVariants({ variant: 'primary' })}>
            Place a limit order
          </Link>
          <Link href="/evidence" className={buttonVariants({ variant: 'outline' })}>
            See a real fill
          </Link>
        </div>
      </div>
      <div className="relative min-w-0">
        {/* DD 7.15 line motif runs behind the card's edges only; the card's solid surface covers it under every number. */}
        <LineMotif className="pointer-events-none absolute inset-x-0 top-12 hidden md:block" />
        <div className="relative md:mx-8 lg:mx-6">
          <HeroReceipt />
        </div>
      </div>
    </div>
  );
}
