'use client';

import { ORDER_STATUSES, type OrderStatus } from '@atprice/core';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { appNetwork } from '../network';
import { NotificationCenter, type SessionStore } from './center';
import type { RecordedNotification } from './types';

/*
 * Browser storage for the notification layer. Every access is wrapped in try/catch: storage can be
 * unavailable (private mode, blocked site data), and then the in-memory behaviour simply continues
 * (notifications.md "Per-viewer catch-up").
 */

const ACTIVITY_KEY = `atprice.activity.${appNetwork.network}`;
const FOLLOWED_KEY = `atprice.followed.${appNetwork.network}`;
const CANCELS_KEY = `atprice.cancels-sent.${appNetwork.network}`;
const seenKey = (ownerPkhHex: string): string => `atprice.seen.${appNetwork.network}.${ownerPkhHex}`;

const read = (storage: () => Storage, key: string): unknown => {
  try {
    const raw = storage().getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch (error) {
    console.warn(`Browser storage read failed for ${key}:`, error);
    return null;
  }
};

const write = (storage: () => Storage, key: string, value: unknown): void => {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Browser storage write failed for ${key}:`, error);
  }
};

const session = (): Storage => window.sessionStorage;
const local = (): Storage => window.localStorage;

const recordedSchema = z.array(
  z.object({
    id: z.string(),
    ref: z.string(),
    kind: z.enum(['attempt', 'chain', 'failure', 'session']),
    icon: z.enum(['hourglass', 'send', 'filled', 'cancelled', 'failed', 'review', 'link', 'unlink']),
    title: z.string(),
    body: z.string(),
    meta: z.string().nullable(),
    txid: z.string().nullable(),
    address: z.string().nullable(),
    actions: z.array(z.object({ label: z.string(), href: z.string() })),
    durationMs: z.number().nullable(),
    flow: z
      .object({ kind: z.enum(['connect', 'funding', 'cancel']), subject: z.string().nullable() })
      .nullable(),
    createdAt: z.number(),
    delivery: z.enum(['raised', 'dialog', 'queued']),
  }),
);

const sessionStore: SessionStore = {
  load(): readonly RecordedNotification[] {
    if (typeof window === 'undefined') return [];
    const parsed = recordedSchema.safeParse(read(session, ACTIVITY_KEY));
    return parsed.success ? parsed.data : [];
  },
  save(entries) {
    if (typeof window !== 'undefined') write(session, ACTIVITY_KEY, entries);
  },
};

let center: NotificationCenter | undefined;

/** The tab's NotificationCenter (DD 7.10). */
export const getNotificationCenter = (): NotificationCenter => {
  center ??= new NotificationCenter(sessionStore);
  return center;
};

const EMPTY: readonly RecordedNotification[] = [];
const noop = (): (() => void) => () => undefined;

/** Every message created in this tab's session, newest first (the Activity session list). */
export const useSessionNotifications = (): readonly RecordedNotification[] => {
  const instance = typeof window === 'undefined' ? undefined : getNotificationCenter();
  return useSyncExternalStore(
    instance?.subscribe ?? noop,
    instance?.getEntries ?? (() => EMPTY),
    () => EMPTY,
  );
};

// Orders this browser follows without owning them (opened from the funding dialog, or a shared link).

const idList = z.array(z.string());

export const followedOrders = (): readonly string[] => {
  if (typeof window === 'undefined') return [];
  const parsed = idList.safeParse(read(session, FOLLOWED_KEY));
  return parsed.success ? parsed.data : [];
};

const followedListeners = new Set<() => void>();
let followedSnapshot: readonly string[] | undefined;

export const followOrder = (orderId: string): void => {
  const current = followedOrders();
  if (current.includes(orderId)) return;
  write(session, FOLLOWED_KEY, [...current, orderId]);
  followedSnapshot = undefined;
  for (const listener of followedListeners) listener();
};

const NO_ORDERS: readonly string[] = [];

/** Order ids this tab follows (`txid:vout`), updated when `followOrder` adds one. */
export const useFollowedOrders = (): readonly string[] =>
  useSyncExternalStore(
    (listener) => {
      followedListeners.add(listener);
      return () => followedListeners.delete(listener);
    },
    () => (followedSnapshot ??= followedOrders()),
    () => NO_ORDERS,
  );

// Cancels sent from this browser, so a lost race reads as #11c instead of a plain fill.

export const markCancelSent = (orderId: string): void => {
  const parsed = idList.safeParse(read(session, CANCELS_KEY));
  const current = parsed.success ? parsed.data : [];
  if (!current.includes(orderId)) write(session, CANCELS_KEY, [...current, orderId]);
};

export const cancelWasSentHere = (orderId: string): boolean => {
  const parsed = idList.safeParse(read(session, CANCELS_KEY));
  return parsed.success && parsed.data.includes(orderId);
};

// Per-viewer catch-up: last seen status per owned order.

const seenSchema = z.record(z.string(), z.enum(ORDER_STATUSES));

/** Null when this owner has never been seen in this browser (first visit seeds silently). */
export const loadSeenStatuses = (ownerPkhHex: string): Record<string, OrderStatus> | null => {
  const parsed = seenSchema.safeParse(read(local, seenKey(ownerPkhHex)));
  return parsed.success ? parsed.data : null;
};

export const saveSeenStatuses = (ownerPkhHex: string, statuses: Record<string, OrderStatus>): void => {
  write(local, seenKey(ownerPkhHex), statuses);
};
