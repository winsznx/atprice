'use client';

import {
  GitDiffIcon,
  HourglassMediumIcon,
  PaperPlaneTiltIcon,
  PlugsConnectedIcon,
  PlugsIcon,
  ProhibitInsetIcon,
  SealCheckIcon,
  WarningOctagonIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AppNotification, NoticeIcon } from '@/lib/notifications/types';
import { cn } from '@/lib/utils';
import { HashChip } from './hash-chip';
import { Button, buttonVariants } from './ui/button';

const ICONS: Readonly<Record<NoticeIcon, { readonly icon: PhosphorIcon; readonly className: string }>> = {
  hourglass: { icon: HourglassMediumIcon, className: 'text-status-pending' },
  send: { icon: PaperPlaneTiltIcon, className: 'text-status-pending' },
  filled: { icon: SealCheckIcon, className: 'text-status-filled' },
  cancelled: { icon: ProhibitInsetIcon, className: 'text-status-cancelled' },
  failed: { icon: WarningOctagonIcon, className: 'text-status-failed' },
  review: { icon: GitDiffIcon, className: 'text-status-review' },
  link: { icon: PlugsConnectedIcon, className: 'text-fg-secondary' },
  unlink: { icon: PlugsIcon, className: 'text-fg-secondary' },
};

/**
 * AtPrice's toast (DD 7.10, notifications.md "How a toast is made"), rendered by `toast.custom` so no
 * Sonner styling or transition applies. The title row and close button stay put; past the height cap
 * the rest scrolls inside the toast and becomes keyboard-scrollable.
 */
export function Notice({ id, notification }: { id: string | number; notification: AppNotification }) {
  const { icon: Icon, className: iconClass } = ICONS[notification.icon];
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const failure = notification.kind === 'failure';

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const measure = () => setOverflowing(body.scrollHeight > body.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const dismiss = () => toast.dismiss(id);

  return (
    <div
      data-notice
      role={failure ? 'alert' : undefined}
      className="flex w-full flex-col overflow-hidden rounded-md border border-border bg-surface p-4 text-fg shadow-popover md:w-[23.75rem]"
    >
      <div className="flex items-start gap-2">
        <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', iconClass)} />
        <p className="min-w-0 flex-1 pt-0.5 text-label font-semibold">{notification.title}</p>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={dismiss}
          aria-label={`Dismiss: ${notification.title}`}
          className="-mt-2 -mr-2"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <div
        ref={bodyRef}
        tabIndex={overflowing ? 0 : undefined}
        className="mt-1 flex min-h-0 flex-col gap-2 overflow-y-auto pl-7"
      >
        <p className="text-body-sm text-fg-secondary">{notification.body}</p>
        {notification.meta === null ? null : (
          <p className="num text-caption text-fg-muted">{notification.meta}</p>
        )}
        {notification.txid === null && notification.actions.length === 0 ? null : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {notification.txid === null ? <span /> : <HashChip value={notification.txid} kind="tx" />}
            <div className="flex flex-wrap gap-2">
              {notification.actions.map((action) =>
                'href' in action ? (
                  <Link
                    key={action.label}
                    href={action.href}
                    onClick={dismiss}
                    className={buttonVariants({ variant: 'outline', size: 'compact' })}
                  >
                    {action.label}
                  </Link>
                ) : (
                  <Button
                    key={action.label}
                    variant="outline"
                    size="compact"
                    onClick={() => {
                      action.run();
                      dismiss();
                    }}
                  >
                    {action.label}
                  </Button>
                ),
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
