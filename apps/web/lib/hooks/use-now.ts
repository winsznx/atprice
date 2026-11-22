'use client';

import { useSyncExternalStore } from 'react';

/*
 * One shared one-second clock for every elapsed timer on the page (`Waiting for your wallet · 0:12`),
 * so many timers cost one interval. The server snapshot is null: timers render only after hydration.
 */

let now = Date.now();
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | undefined;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (interval === undefined) {
    now = Date.now();
    interval = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
  };
};

export const useNow = (): number | null =>
  useSyncExternalStore(
    subscribe,
    () => now,
    () => null,
  );

/** Milliseconds since `since`, ticking each second; null before hydration or when `since` is null. */
export const useElapsed = (since: number | null): number | null => {
  const current = useNow();
  if (current === null || since === null) return null;
  return Math.max(0, current - since);
};
