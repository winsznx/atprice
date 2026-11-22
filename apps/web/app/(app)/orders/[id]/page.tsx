import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { OrderDetailScreen } from '@/components/orders/order-detail-screen';
import { isOrderId, openGraphDescription, openGraphTitle, titleBlock } from '@/components/orders/order-title';
import { STATUS_DISPLAY } from '@/components/status-badge';
import { api } from '@/lib/api/client';
import type { Order } from '@/lib/api/schemas';

/** A link preview must not wait on a slow API: past this, the page renders and the browser loads it. */
const SERVER_FETCH_MS = 3_000;

/**
 * The public record for link previews and first paint, fetched once per request. Any failure is left
 * to the browser, which shows the named not-found or error state; the server never guesses.
 */
const loadPublicOrder = cache(async (txid: string): Promise<Order | null> => {
  try {
    return await api.order(txid, { signal: AbortSignal.timeout(SERVER_FETCH_MS) });
  } catch (error) {
    console.warn(`Server render of order ${txid} continues without its record:`, error);
    return null;
  }
});

interface Params {
  readonly params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  if (!isOrderId(id)) return { title: 'Order not found' };
  const order = await loadPublicOrder(id);
  if (order === null) return { title: 'Order' };
  const title = openGraphTitle(order);
  const description = openGraphDescription(order, STATUS_DISPLAY[order.status].label);
  return {
    title: titleBlock(order).heading,
    description,
    openGraph: { title, description, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function OrderPage({ params }: Params) {
  const { id } = await params;
  if (!isOrderId(id)) notFound();
  return <OrderDetailScreen txid={id} initialOrder={await loadPublicOrder(id)} />;
}
