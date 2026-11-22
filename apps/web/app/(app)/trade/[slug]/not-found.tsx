import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { notFoundMetadata } from '@/lib/seo';

export const metadata: Metadata = notFoundMetadata('Market not found');

export default function MarketNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[35rem] flex-col items-start gap-4 px-(--space-gutter) py-12">
      <h1 className="font-display text-heading-2 text-fg">Market not found</h1>
      <p className="text-body text-fg-secondary">This market does not exist on AtPrice.</p>
      <Link href="/markets" className={buttonVariants({ variant: 'primary' })}>
        See markets
      </Link>
    </div>
  );
}
