import { renderOgCard } from '@/lib/og/card';

export const alt = 'Trade on AtPrice: place a limit order on a Bitcoin Cash token market';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return renderOgCard({
    title: 'Place a limit order',
    description: 'Pick your price. The order waits in its own contract and fills through a Cauldron pool.',
    label: 'Trade',
    path: '/trade',
    note: 'Limit orders on Bitcoin Cash',
  });
}
