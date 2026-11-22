'use client';

import { ListChecksIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { EmptyState, ErrorState, LoadingRegion } from '@/components/states';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFailure } from '@/lib/api/errors';
import type { Evidence } from '@/lib/api/schemas';
import { formatBlockHeight } from '@/lib/format';
import { appNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { proofCounts, RECENT_LIMIT, useProofEvidence } from './proof-data';
import { RecentTransactionsTable } from './recent-transactions';
import { Band, SECTION_HEADING } from './section';

export const PROOF_ID = 'live-proof';

const count = (value: number): string => value.toLocaleString('en-US');

function Stat({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-(--space-panel)">
      <dt className="text-body-sm text-fg-muted">{label}</dt>
      <dd className="num text-num-xl text-fg">{value}</dd>
      {note === undefined ? null : <dd className="text-caption text-fg-muted">{note}</dd>}
    </div>
  );
}

function Measured({ evidence }: { evidence: Evidence }) {
  const counts = proofCounts(evidence.orders, evidence.nextCursor);
  const basis = counts.complete
    ? `Counted from every completed order AtPrice’s server lists on ${appNetwork.name}: ${count(counts.counted)}.`
    : `Counted from the ${count(counts.counted)} most recent completed orders AtPrice’s server lists on ${appNetwork.name}. Older ones are on the evidence page.`;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
        <Stat label="Orders filled" value={count(counts.fills)} />
        <Stat
          label="Paid above the minimum"
          value={`${count(counts.fillsAboveMinimum)} of ${count(counts.fills)}`}
          note="fills"
        />
        <Stat
          label="Sent by AtPrice’s keeper"
          value={`${count(counts.keeperFills)} of ${count(counts.fills)}`}
          note="fills"
        />
        <Stat label="Orders cancelled" value={count(counts.cancels)} note="refunded to the owner" />
      </dl>
      <p className="text-body-sm text-fg-muted">
        {basis}
        {counts.newestBlock === null ? null : (
          <>
            {' Newest settlement in block '}
            <span className="num text-fg">{formatBlockHeight(counts.newestBlock)}</span>.
          </>
        )}
      </p>
    </div>
  );
}

function ProofSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((cell) => (
          <Skeleton key={cell} className="h-28 w-full rounded-lg" />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-14 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}

/** Live proof (landing): counts taken only from `GET /evidence`, then the five newest settlements. */
export function LiveProof() {
  const evidence = useProofEvidence();
  let body;
  if (evidence.data !== undefined) {
    body =
      evidence.data.orders.length === 0 ? (
        <EmptyState
          icon={ListChecksIcon}
          headingLevel={3}
          title={`No completed orders on ${appNetwork.name} yet`}
          className="bg-surface"
          action={
            <Link href="/trade" className={buttonVariants({ variant: 'outline' })}>
              Place a limit order
            </Link>
          }
        >
          Fills and cancels appear here once they confirm on chain. Nothing is shown until then.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-10">
          <Measured evidence={evidence.data} />
          <div className="flex flex-col gap-4">
            <h3 className="font-display text-heading-3 text-fg">{`The ${RECENT_LIMIT} most recent transactions`}</h3>
            <div className="min-w-0 rounded-lg bg-surface">
              <RecentTransactionsTable orders={evidence.data.orders.slice(0, RECENT_LIMIT)} />
            </div>
          </div>
        </div>
      );
  } else if (evidence.isError) {
    body = (
      <ErrorState
        {...apiFailure(evidence.error, 'Live numbers can’t load.')}
        onRetry={() => void evidence.refetch()}
        retrying={evidence.isFetching}
      />
    );
  } else {
    body = (
      <LoadingRegion thing="live numbers" onRetry={() => void evidence.refetch()}>
        <ProofSkeleton />
      </LoadingRegion>
    );
  }
  return (
    <Band labelledBy={PROOF_ID} tone="sunken" className="flex flex-col gap-8">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="flex max-w-[64ch] flex-col gap-3">
          <h2 id={PROOF_ID} tabIndex={-1} className={SECTION_HEADING}>
            {`Settled on ${appNetwork.name}, on the record`}
          </h2>
          <p className="text-body text-fg-secondary">
            Every number here is counted from confirmed transactions AtPrice has observed. Each one links to
            the {appNetwork.explorer.label}, so you can check it yourself.
          </p>
        </div>
        <Link href="/evidence" className={cn(buttonVariants({ variant: 'outline' }), 'justify-self-start')}>
          View all evidence
        </Link>
      </div>
      <div className="min-w-0">{body}</div>
    </Band>
  );
}
