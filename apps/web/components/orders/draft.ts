'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { deleteDraft, DRAFT_KEY, loadDraft, type StoredDraft } from '@/lib/orders/draft-store';

/*
 * My orders reads the unfunded draft through the store the funding confirmation writes
 * (`lib/orders/draft-store.ts`), so both screens share one schema. This file only adds a
 * subscription, so the notice disappears in the same render as `Dismiss`, and in other tabs through
 * the `storage` event.
 */

export type UnfundedDraft = StoredDraft;

const listeners = new Set<() => void>();

const readRaw = (): string | null => {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY);
  } catch (error) {
    console.warn(`Browser storage read failed for ${DRAFT_KEY}:`, error);
    return null;
  }
};

/** Deletes the draft (Dismiss, or once the owner's list shows its contract) and updates the notice. */
export const removeDraft = (draft: UnfundedDraft): void => {
  deleteDraft(draft.draftId);
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === DRAFT_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
};

/** The raw string is the snapshot, so React compares by value; the store parses it. */
export const useStoredDraft = (): UnfundedDraft | null => {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  return useMemo(() => (raw === null ? null : loadDraft()), [raw]);
};
