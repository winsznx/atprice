import { fundedText, isOrderId, orderHeadline } from '@/components/orders/order-title';
import { loadPublicOrder } from '@/components/orders/public-order';
import { STATUS_DISPLAY } from '@/components/status-badge';
import { truncateMiddle } from '@/lib/format';
import { renderOgCard } from '@/lib/og/card';

export const alt = 'A limit order on AtPrice';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * The order's side, token, limit and status, the same public fields as its Open Graph tags. Never an
 * address. Without the API the card still names the order by its id rather than guessing its state.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isOrderId(id)) return new Response('Not found', { status: 404 });
  const order = await loadPublicOrder(id);
  const path = `/orders/${truncateMiddle(id, 8, 6)}`;
  if (order === null) {
    return renderOgCard({
      title: 'Limit order on Bitcoin Cash',
      description: 'Open the order to see its status, terms and transactions.',
      label: 'Order',
      path,
      note: 'Non-custodial',
    });
  }
  const { tone, label } = STATUS_DISPLAY[order.status];
  return renderOgCard({
    title: orderHeadline(order),
    description: fundedText(order),
    label: 'Order',
    status: { tone, label },
    path,
    note: 'Non-custodial',
  });
}
