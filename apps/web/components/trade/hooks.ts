'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

/** The amount the quote is requested for settles 250 ms after typing stops (trade.md "Data sources"). */
export const QUOTE_DEBOUNCE_MS = 250;

/** The value after it stopped changing for `delayMs`; a timer is the external system synced here. */
export const useDebouncedValue = <T>(value: T, delayMs: number): T => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
};

/**
 * Text for a polite live region, updated at most once per `intervalMs`, so typing doesn't flood a
 * screen reader (trade.md: the min-received `<output>` announces at most every 2 s).
 */
export const useThrottledText = (text: string, intervalMs: number): string => {
  const [shown, setShown] = useState(text);
  const lastAt = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, lastAt.current + intervalMs - Date.now());
    const timer = setTimeout(() => {
      lastAt.current = Date.now();
      setShown(text);
    }, wait);
    return () => clearTimeout(timer);
  }, [text, intervalMs]);
  return shown;
};

/** On-screen keyboard: the visual viewport is more than 150 px shorter than the layout viewport. */
const KEYBOARD_THRESHOLD_PX = 150;

const subscribeViewport = (listener: () => void): (() => void) => {
  const viewport = window.visualViewport;
  viewport?.addEventListener('resize', listener);
  window.addEventListener('resize', listener);
  return () => {
    viewport?.removeEventListener('resize', listener);
    window.removeEventListener('resize', listener);
  };
};

export const useKeyboardOpen = (): boolean =>
  useSyncExternalStore(
    subscribeViewport,
    () => {
      const viewport = window.visualViewport;
      return viewport !== null && window.innerHeight - viewport.height > KEYBOARD_THRESHOLD_PX;
    },
    () => false,
  );

/**
 * Writes the sticky action bar's measured height to `--sticky-bar-h` on `<html>` (DD 8), so the body's
 * bottom padding and `scroll-padding-bottom` count the bar once. Back to `0px` when the bar is gone.
 */
export const useStickyBarHeight = (ref: RefObject<HTMLElement | null>, active: boolean): void => {
  useEffect(() => {
    const root = document.documentElement;
    const element = ref.current;
    if (!active || element === null) {
      root.style.setProperty('--sticky-bar-h', '0px');
      return;
    }
    const write = () =>
      root.style.setProperty('--sticky-bar-h', `${element.getBoundingClientRect().height}px`);
    write();
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.setProperty('--sticky-bar-h', '0px');
    };
  }, [ref, active]);
};

/**
 * Whether any part of `ref` is in the viewport, watched with an `IntersectionObserver`. Disabled, or
 * before the first observation, it reads `true`, so the first paint matches the always-on case.
 */
export const useOnScreen = (ref: RefObject<HTMLElement | null>, enabled: boolean): boolean => {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || element === null) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return enabled ? onScreen : true;
};

/** Header height plus 24 px: where the sticky ticket rests (trade.md "Layout"). */
const STICKY_TOP_PX = 88;

/**
 * The centre ticket is sticky only when it fits: its height plus 88 px within the viewport, so
 * `Review order` is never stuck below the fold of a short laptop screen (trade.md "Layout").
 */
export const useTicketFits = (ref: RefObject<HTMLElement | null>): boolean => {
  const [fits, setFits] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () =>
      setFits(element.getBoundingClientRect().height + STICKY_TOP_PX <= window.innerHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref]);
  return fits;
};
