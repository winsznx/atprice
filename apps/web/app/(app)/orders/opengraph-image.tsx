import { renderOgCard } from '@/lib/og/card';

export const alt = 'My orders on AtPrice';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return renderOgCard({
    title: 'Your limit orders',
    description: 'Open, pending and finished orders, read from the chain by your owner address.',
    label: 'Orders',
    path: '/orders',
    note: 'Cancel any time',
  });
}
