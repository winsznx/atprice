'use client';

import { useSyncExternalStore } from 'react';

/**
 * Which wallet overlay is open, and where focus goes when the connect modal closes (DD 7.8 "Focus
 * after connecting"): the trigger if it is still in the document, otherwise the element the entry
 * point names as its replacement. The modal and the panel are mounted once in the app shell.
 */
export interface ReturnFocus {
  readonly trigger: HTMLElement | null;
  /** The replacement target when the trigger was removed (`Review order`, the page `<h1>`, ...). */
  readonly fallback?: () => HTMLElement | null;
}

export interface WalletOverlayState {
  readonly connectOpen: boolean;
  readonly panelOpen: boolean;
  readonly returnFocus: ReturnFocus | null;
}

let state: WalletOverlayState = { connectOpen: false, panelOpen: false, returnFocus: null };
const listeners = new Set<() => void>();

const set = (next: WalletOverlayState): void => {
  state = next;
  for (const listener of listeners) listener();
};

/** Every `Connect wallet` button calls this with itself as the trigger. */
export const openConnectModal = (returnFocus: ReturnFocus): void =>
  set({ connectOpen: true, panelOpen: false, returnFocus });

export const closeConnectModal = (): void => set({ ...state, connectOpen: false });

export const openWalletPanel = (): void => set({ connectOpen: false, panelOpen: true, returnFocus: null });

export const closeWalletPanel = (): void => set({ ...state, panelOpen: false });

const SERVER: WalletOverlayState = { connectOpen: false, panelOpen: false, returnFocus: null };

export const useWalletOverlay = (): WalletOverlayState =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => SERVER,
  );

/** Resolves the focus target on close; never `body` (non-interactive targets carry `tabindex="-1"`). */
export const resolveReturnFocus = (returnFocus: ReturnFocus | null): HTMLElement | null => {
  if (returnFocus === null) return null;
  if (returnFocus.trigger?.isConnected) return returnFocus.trigger;
  return returnFocus.fallback?.() ?? null;
};
