'use client';

import { useSyncExternalStore } from 'react';

const useMediaQuery = (query: string, serverValue: boolean): boolean =>
  useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  );

/** `md` and up (DD 5.10 `--breakpoint-md`). */
export const useIsMdUp = (): boolean => useMediaQuery('(min-width: 48rem)', false);

/** `lg` and up: desktop header, right-side wallet sheet. */
export const useIsLgUp = (): boolean => useMediaQuery('(min-width: 64rem)', false);

/** At least 50rem tall: three toasts at md+ (DD 7.10). */
export const useIsTall = (): boolean => useMediaQuery('(min-height: 50rem)', false);

/** DD 5.10's short rule, matching the CSS `@media (max-height: 30rem)` exactly. */
export const useIsShort = (): boolean => useMediaQuery('(max-height: 30rem)', false);
