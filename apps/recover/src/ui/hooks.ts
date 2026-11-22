import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

/* One shared one-second clock for every elapsed timer on the page, so many timers cost one interval. */
let now = Date.now();
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | undefined;

const subscribeClock = (listener: () => void): (() => void) => {
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

export const useNow = (): number => useSyncExternalStore(subscribeClock, () => now);

/** Milliseconds since `since`, ticking each second; null when `since` is null. */
export const useElapsed = (since: number | null): number | null => {
  const current = useNow();
  return since === null ? null : Math.max(0, current - since);
};

/**
 * Moves focus to `ref` whenever `key` changes after the first render (recover.md: each state change
 * moves focus to its status heading, announced once). The heading carries `tabindex="-1"`. Leaving
 * `quietFrom` (a loading state the user didn't cause) keeps focus where it is.
 */
export const useFocusOnChange = (ref: RefObject<HTMLElement | null>, key: string, quietFrom?: string): void => {
  const previous = useRef(key);
  useLayoutEffect(() => {
    if (previous.current === key) return;
    const from = previous.current;
    previous.current = key;
    if (from !== quietFrom) ref.current?.focus();
  }, [key, ref, quietFrom]);
};

/** Keeps `callback` current for long-lived subscriptions without re-subscribing on every render. */
export const useLatest = <T>(value: T): RefObject<T> => {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
};

const MD_QUERY = '(min-width: 48rem)';

const subscribeMd = (listener: () => void): (() => void) => {
  const query = window.matchMedia(MD_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};

/** True at DD 5.10 `md` and up; the pairing block puts the deep link first below it (wallet.md). */
export const useIsMdUp = (): boolean => useSyncExternalStore(subscribeMd, () => window.matchMedia(MD_QUERY).matches);
