import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ActivityScreen } from '@/components/orders/activity/activity-screen';
import { pageMetadata } from '@/lib/seo';

export const metadata: Metadata = pageMetadata({
  title: 'Activity',
  description:
    'Every funding, fill and cancel transaction of AtPrice orders on Bitcoin Cash, with its confirmation state and explorer link.',
  path: '/activity',
});

function ActivityFallback() {
  return (
    <div className="mx-auto w-full max-w-(--container-content) px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg) lg:py-12">
      <h1 className="font-display text-heading-2 text-fg md:text-heading-1">Activity</h1>
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense fallback={<ActivityFallback />}>
      <ActivityScreen />
    </Suspense>
  );
}
