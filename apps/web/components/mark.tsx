import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * DD 2 mark: your limit (the line), a price path rising to meet it, and the fill (the dot on the line).
 * Colours come from tokens, so no hex sits in component code. Next to the wordmark it is decorative.
 */
export function Mark({
  size = 28,
  decorative = true,
  className,
}: {
  size?: number | undefined;
  decorative?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': 'AtPrice' })}
      focusable="false"
    >
      <rect width="32" height="32" rx="9" className="fill-brand" />
      <path d="M6 11H26" fill="none" strokeWidth="2" strokeLinecap="round" className="stroke-brand-fg" />
      <path
        d="M6 24L10 19.5L13 22L17 11"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-brand-fg"
      />
      <circle cx="17" cy="11" r="3.25" strokeWidth="1.5" className="fill-brand-fg stroke-brand" />
    </svg>
  );
}

/** `At` at 400, `Price` at 600, no space, -0.025em (DD 2 "Wordmark"). Never below 20px. */
export function Wordmark({ className }: { className?: string | undefined }) {
  return (
    <span className={cn('font-display text-[1.25rem] leading-none tracking-[-0.025em] text-fg', className)}>
      <span className="font-normal">At</span>
      <span className="font-semibold">Price</span>
    </span>
  );
}

/**
 * Header lockup: 28px mark, 20px wordmark, gap 0.375 x mark height. Below 390px the wordmark stays in
 * the link as visually hidden text so the header fits 320px (DD 8).
 */
export function Lockup({ className }: { className?: string | undefined }) {
  return (
    <Link
      href="/"
      className={cn('inline-flex min-h-(--size-control) items-center gap-[0.65625rem] rounded-sm', className)}
    >
      <Mark />
      <Wordmark className="max-xs:sr-only" />
    </Link>
  );
}
