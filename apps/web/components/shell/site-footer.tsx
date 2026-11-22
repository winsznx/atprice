import Link from 'next/link';
import { publicEnv } from '@/lib/env/public';
import { appNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { CONTROL_TRANSITION } from '../ui/button';

const LINK = cn(
  'inline-flex min-h-(--size-control) items-center text-body-sm text-link underline-offset-4 hover:underline',
  CONTROL_TRANSITION,
);

/** DD 8 footer: Recover, Evidence, Contract limits, Source code, the network and the build version. */
export function SiteFooter() {
  const source = publicEnv.banner.sourceRepoUrl;
  return (
    <footer className="mt-(--space-section) border-t border-border bg-surface-sunken">
      <div className="mx-auto flex max-w-(--container-app) flex-col gap-4 px-(--space-gutter) py-6 md:flex-row md:flex-wrap md:items-center md:justify-between md:px-(--space-gutter-md) lg:px-(--space-gutter-lg)">
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6">
            <li>
              <Link href="/recover" className={LINK}>
                Recover an order
              </Link>
            </li>
            <li>
              <Link href="/evidence" className={LINK}>
                Evidence
              </Link>
            </li>
            <li>
              <Link href="/#limits" className={LINK}>
                Contract limits
              </Link>
            </li>
            <li>
              {source.published ? (
                <a href={source.value} target="_blank" rel="noopener noreferrer" className={LINK}>
                  Source code<span className="sr-only">, opens in a new tab</span>
                </a>
              ) : (
                <span className="inline-flex min-h-(--size-control) items-center text-body-sm text-fg-muted">
                  Source code: not yet published
                </span>
              )}
            </li>
          </ul>
        </nav>
        <p className="text-caption text-fg-muted">
          <span className="capitalize">{appNetwork.name}</span> · build{' '}
          <span className="hash">{publicEnv.buildSha}</span>
        </p>
      </div>
    </footer>
  );
}
