'use client';

import { useEffect } from 'react';
import { ErrorState, FUNDS_STILL_SAFE } from '@/components/states';

/** A render failure on an app-shell page is a named, visible state with Retry, never a blank page. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Page render failed:', error);
  }, [error]);
  return (
    <div className="mx-auto w-full max-w-(--container-content) px-(--space-gutter) py-8 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg)">
      <h1 className="mb-4 font-display text-heading-2 text-fg">This page failed to load</h1>
      <ErrorState
        what={error.message === '' ? 'Something on this page failed while rendering.' : error.message}
        code={error.digest === undefined ? 'PAGE_RENDER_FAILED' : `PAGE_RENDER_FAILED ${error.digest}`}
        stillWorks={FUNDS_STILL_SAFE}
        onRetry={reset}
      />
    </div>
  );
}
