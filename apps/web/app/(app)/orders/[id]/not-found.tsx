import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { notFoundMetadata } from '@/lib/seo';

export const metadata: Metadata = notFoundMetadata('Order not found');

/** order-detail.md "Route": a malformed id is a 404 that says what an order id is. */
export default function InvalidOrderId() {
  return (
    <div className="mx-auto flex w-full max-w-[35rem] flex-col items-start gap-4 px-(--space-gutter) py-12">
      <h1 className="font-display text-heading-2 text-fg md:text-heading-1">Order not found</h1>
      <p className="text-body text-fg-secondary">
        This isn’t a valid order id. Order ids are funding transaction ids (64 characters).
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/orders" className={buttonVariants({ variant: 'primary' })}>
          My orders
        </Link>
        <Link href="/recover" className={buttonVariants({ variant: 'outline' })}>
          Recover an order
        </Link>
      </div>
    </div>
  );
}
