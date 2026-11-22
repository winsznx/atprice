import { renderOgCard } from '@/lib/og/card';

export const alt = 'AtPrice markets: Bitcoin Cash tokens backed by Cauldron pools';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return renderOgCard({
    title: 'Bitcoin Cash token markets',
    description: 'Live rates, liquidity and availability for every market AtPrice can fill through Cauldron pools.',
    label: 'Markets',
    path: '/markets',
    note: 'Backed by Cauldron pools',
  });
}
