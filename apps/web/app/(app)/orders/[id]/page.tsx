import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OrderDetailScreen } from '@/components/orders/order-detail-screen';
import { isOrderId, openGraphDescription, openGraphTitle, titleBlock } from '@/components/orders/order-title';
import { loadPublicOrder } from '@/components/orders/public-order';
import { STATUS_DISPLAY } from '@/components/status-badge';
import { notFoundMetadata, pageMetadata } from '@/lib/seo';

interface Params {
  readonly params: Promise<{ id: string }>;
}

/**
 * Noindex: an order page is one person's trade, and its owner address is on the page. Bots may still
 * fetch it, so a shared link unfurls with the public fields below (no addresses, order-detail.md).
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  if (!isOrderId(id)) return notFoundMetadata('Order not found');
  const order = await loadPublicOrder(id);
  const path = `/orders/${id}`;
  if (order === null) {
    return pageMetadata({
      title: 'Order',
      shareTitle: 'Limit order on AtPrice',
      description: 'A limit order on Bitcoin Cash. Open it to see its status, terms and transactions.',
      path,
      indexable: false,
    });
  }
  return pageMetadata({
    title: titleBlock(order).heading,
    shareTitle: openGraphTitle(order),
    description: openGraphDescription(order, STATUS_DISPLAY[order.status].label),
    path,
    indexable: false,
  });
}

export default async function OrderPage({ params }: Params) {
  const { id } = await params;
  if (!isOrderId(id)) notFound();
  return <OrderDetailScreen txid={id} initialOrder={await loadPublicOrder(id)} />;
}
