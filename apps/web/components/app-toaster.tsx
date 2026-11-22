'use client';

import { useEffect } from 'react';
import { toast, Toaster } from 'sonner';
import { useIsMdUp, useIsTall } from '@/lib/hooks/use-media-query';
import { getNotificationCenter } from '@/lib/notifications/store';
import type { AppNotification } from '@/lib/notifications/types';
import { Notice } from './notice';

/** DD 7.10: one bottom value for both `offset` and `mobileOffset`, so toasts clear the sticky bar at every width. */
const TOAST_OFFSET = {
  bottom: 'calc(var(--sticky-bar-h) + 16px + env(safe-area-inset-bottom))',
  left: 16,
  right: 16,
} as const;

const raise = (notification: AppNotification): void => {
  toast.custom((id) => <Notice id={id} notification={notification} />, {
    id: notification.id,
    duration: notification.durationMs ?? Number.POSITIVE_INFINITY,
  });
};

/**
 * Writes `--toast-stack-h`: the distance from the top of the highest toast to the top of the sticky bar
 * (or the viewport bottom), `0px` when none shows. `html` adds it to `scroll-padding-bottom` and `body`
 * to its bottom padding (DD 8), so focus and the footer stay clear of a persistent toast.
 */
const measureStack = (): void => {
  const root = document.documentElement;
  const toasts = document.querySelectorAll<HTMLElement>('[data-sonner-toast]');
  let top = Number.POSITIVE_INFINITY;
  for (const element of toasts) {
    if (element.dataset.removed === 'true') continue;
    top = Math.min(top, element.getBoundingClientRect().top);
  }
  const bar = Number.parseFloat(getComputedStyle(root).getPropertyValue('--sticky-bar-h')) || 0;
  const height = Number.isFinite(top) ? Math.max(0, window.innerHeight - bar - top) : 0;
  root.style.setProperty('--toast-stack-h', `${Math.ceil(height)}px`);
};

/** The app shell's toast region (DD 7.10, motion.md M-04a). Not part of the Recover shell. */
export function AppToaster() {
  const isMdUp = useIsMdUp();
  const isTall = useIsTall();

  useEffect(() => getNotificationCenter().attachRaiser(raise), []);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measureStack);
    };
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(() => {
      for (const element of document.querySelectorAll('[data-sonner-toast]')) resize.observe(element);
      schedule();
    });
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-removed'],
    });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', schedule);
      document.documentElement.style.setProperty('--toast-stack-h', '0px');
    };
  }, []);

  return (
    <Toaster
      expand
      visibleToasts={isMdUp && isTall ? 3 : 1}
      swipeDirections={[]}
      position={isMdUp ? 'bottom-right' : 'bottom-center'}
      offset={TOAST_OFFSET}
      mobileOffset={TOAST_OFFSET}
      hotkey={['altKey', 'KeyT']}
      // Sonner appends the hotkey (`alt+T`) to this label itself.
      containerAriaLabel="Notifications, press Alt+T to focus. Shortcut:"
      style={{ zIndex: 'var(--z-toast)' }}
    />
  );
}
