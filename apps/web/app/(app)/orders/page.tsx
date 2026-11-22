import type { Metadata } from 'next';
import { OrdersScreen } from '@/components/orders/orders-screen';

export const metadata: Metadata = {
  title: 'My orders',
  description: 'Your AtPrice limit orders, open, pending and finished, read from the chain by your owner address.',
};

export default function OrdersPage() {
  return <OrdersScreen />;
}
