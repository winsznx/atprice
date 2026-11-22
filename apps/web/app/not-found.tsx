import type { Metadata } from 'next';
import Link from 'next/link';
import { Lockup } from '@/components/mark';
import { buttonVariants } from '@/components/ui/button';
import { notFoundMetadata } from '@/lib/seo';

export const metadata: Metadata = notFoundMetadata('Page not found');

export default function NotFound() {
  return (
    <main
      id="content"
      className="mx-auto flex min-h-dvh w-full max-w-[35rem] flex-col items-start justify-center gap-4 px-(--space-gutter)"
    >
      <Lockup />
      <h1 className="font-display text-heading-2 text-fg">Page not found</h1>
      <p className="text-body text-fg-secondary">
        There is no AtPrice page at this address. Open orders stay on chain whatever page you are on.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/wallet" className={buttonVariants({ variant: 'primary' })}>
          Go to your wallet
        </Link>
        <Link href="/recover" className={buttonVariants({ variant: 'outline' })}>
          Recover an order
        </Link>
      </div>
    </main>
  );
}
