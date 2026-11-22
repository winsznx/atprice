import { renderOgCard } from '@/lib/og/card';

export const alt = 'AtPrice activity: every funding, fill and cancel transaction';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return renderOgCard({
    title: 'Every order transaction',
    description: 'Funding, fill and cancel transactions of AtPrice orders, with their state on chain.',
    label: 'Activity',
    path: '/activity',
    note: 'Read from the chain',
  });
}
