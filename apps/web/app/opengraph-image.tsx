import { renderOgCard } from '@/lib/og/card';

export const alt = 'AtPrice: limit orders for Bitcoin Cash tokens, filled through Cauldron pools';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return renderOgCard({
    title: 'Set your price. Trade when the market meets it.',
    description: 'Non-custodial limit orders for CashTokens, filled through Cauldron pools. Cancel any time.',
    path: '/',
    note: 'Limit orders on Bitcoin Cash',
  });
}
