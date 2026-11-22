'use client';

import { ArrowSquareOutIcon, QrCodeIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { BannerValue } from '@/lib/env/schema';
import { publicEnv } from '@/lib/env/public';
import { truncateMiddle } from '@/lib/format';
import { cn } from '@/lib/utils';
import { HashChip } from '../hash-chip';
import { QrCode } from '../qr-code';
import { BchLogo } from '../token-logo';
import { CONTROL_TRANSITION } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

function BannerLink({ value, name, children }: { value: BannerValue; name: string; children: ReactNode }) {
  if (!value.published) {
    // DD 7.14: the only placeholder allowed anywhere, plain text and not a tab stop.
    return <span className="text-banner-fg-muted">{`${name}: not yet published`}</span>;
  }
  return (
    <a
      href={value.value}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex min-h-(--size-control) items-center gap-1 text-banner-link underline underline-offset-4',
        CONTROL_TRANSITION,
      )}
    >
      {children}
      <span className="sr-only">, opens in a new tab</span>
      <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
    </a>
  );
}

function EmberAddress({ value }: { value: BannerValue }) {
  if (!value.published)
    return <span className="text-banner-fg-muted">EMBER2026 address: not yet published</span>;
  const address = value.value;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-banner-fg-muted">EMBER2026 address</span>
      <HashChip
        value={address}
        kind="address"
        inverse
        label={`EMBER2026 donation address, ${truncateMiddle(address)}, copy`}
        trailing={
          <Popover>
            <PopoverTrigger
              aria-label="Show QR code of the EMBER2026 address"
              className={cn(
                'inline-flex size-9 shrink-0 items-center justify-center rounded-sm text-banner-fg-muted hover:bg-banner-chip-hover',
                CONTROL_TRANSITION,
              )}
            >
              <QrCodeIcon aria-hidden="true" className="size-4" />
            </PopoverTrigger>
            <PopoverContent className="flex max-w-[15rem] flex-col items-center gap-3">
              <QrCode value={address} size={200} label="QR code of the EMBER2026 donation address" />
              <p className="hash text-mono-sm text-fg">{address}</p>
            </PopoverContent>
          </Popover>
        }
      />
    </span>
  );
}

/**
 * Top-of-page BLAZE banner for `/`: presentation, source code and the EMBER2026 address, each from
 * build-time config. A missing value reads
 * `{Item}: not yet published`; an invalid one already failed the build with a named EnvError.
 */
export function BlazeBanner() {
  const banner = publicEnv.banner;
  return (
    <section
      aria-label="BCH BLAZE 2026 entry details"
      data-surface="banner"
      className="bg-banner text-body-sm text-banner-fg"
    >
      <div className="mx-auto flex max-w-(--container-app) flex-col gap-2 px-(--space-gutter) py-3 md:px-(--space-gutter-md) lg:px-(--space-gutter-lg)">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <BchLogo />
            BCH BLAZE 2026 entry
          </span>
          <BannerLink value={banner.deckUrl} name="Presentation">
            Presentation
          </BannerLink>
          <BannerLink value={banner.sourceRepoUrl} name="Source code">
            Source code
          </BannerLink>
        </p>
        <EmberAddress value={banner.emberAddress} />
      </div>
    </section>
  );
}
