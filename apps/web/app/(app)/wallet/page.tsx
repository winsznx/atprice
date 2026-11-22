import type { Metadata } from 'next';
import { WalletPageContent } from '@/components/wallet/wallet-page-content';
import { pageMetadata } from '@/lib/seo';

/** Shows only the connected wallet, so there is nothing here for a search engine to list. */
export const metadata: Metadata = pageMetadata({
  title: 'Wallet',
  description:
    'Connect a WizardConnect wallet and see what AtPrice can see from it: owner address, network and balances. Your keys stay in your wallet.',
  path: '/wallet',
  indexable: false,
});

export default function WalletPage() {
  return (
    <div className="mx-auto w-full max-w-(--container-content) px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12">
      <div className="mx-auto flex max-w-[35rem] flex-col gap-6">
        <h1 className="font-display text-heading-2 text-fg md:text-heading-1">Wallet</h1>
        <WalletPageContent />
      </div>
    </div>
  );
}
