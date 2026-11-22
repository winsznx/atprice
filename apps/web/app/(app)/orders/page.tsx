import type { Metadata } from 'next';
import { OrdersScreen } from '@/components/orders/orders-screen';
import { pageMetadata } from '@/lib/seo';

/** One wallet's orders: noindex, like every order page (lib/seo.ts NOINDEX). */
export const metadata: Metadata = pageMetadata({
  title: 'My orders',
  description: 'Your AtPrice limit orders, open, pending and finished, read from the chain by your owner address.',
  path: '/orders',
  indexable: false,
});

export default function OrdersPage() {
  return <OrdersScreen />;
}
