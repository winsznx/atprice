import { renderOgCard } from '@/lib/og/card';

export const alt = 'AtPrice evidence: every completed order, read from the blockchain';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return renderOgCard({
    title: 'Every fill, on chain',
    description: 'Each completed order with its transactions and a check you can run from your own browser.',
    label: 'Evidence',
    path: '/evidence',
    note: 'Verify it yourself',
  });
}
