import { renderOgCard } from '@/lib/og/card';

export const alt = 'Connect a wallet to AtPrice';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return renderOgCard({
    title: 'Connect your wallet',
    description: 'Pair a WizardConnect wallet by QR code. Your keys stay in your wallet, and you approve each transaction there.',
    label: 'Wallet',
    path: '/wallet',
    note: 'Non-custodial',
  });
}
