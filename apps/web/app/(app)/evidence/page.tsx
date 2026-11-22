import type { Metadata } from 'next';
import { EvidencePage } from '@/components/evidence/evidence-page';

export const metadata: Metadata = {
  title: 'Evidence',
  description:
    'Every completed AtPrice order, read from the blockchain, with explorer links and a check you can run from your own browser.',
};

const TXID = /^[0-9a-fA-F]{64}$/;

export default async function EvidenceRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { order } = await searchParams;
  const orderTxid = typeof order === 'string' && TXID.test(order) ? order.toLowerCase() : null;
  return (
    <div className="mx-auto w-full max-w-(--container-content) px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12">
      <EvidencePage orderTxid={orderTxid} />
    </div>
  );
}
