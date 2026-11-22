'use client';

import type { OrderStatus } from '@atprice/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { queries } from '@/lib/api/queries';
import type { Order, Outpoint } from '@/lib/api/schemas';
import { walletConnected, walletDisconnected } from '@/lib/notifications/messages';
import {
  cancelWasSentHere,
  getNotificationCenter,
  loadSeenStatuses,
  saveSeenStatuses,
  useFollowedOrders,
} from '@/lib/notifications/store';
import { messagesForStatusChange } from '@/lib/notifications/transitions';
import { getWalletConnector, ownerOf, useWalletState } from '@/lib/wallet/store';

const OPEN_POLL_MS = 15_000;
const PENDING_POLL_MS = 5_000;
const PENDING: readonly OrderStatus[] = ['FUNDING_PENDING', 'EXECUTION_PENDING', 'CANCELLATION_PENDING'];

const pollInterval = (orders: readonly Order[] | undefined): number =>
  orders?.some((order) => PENDING.includes(order.status)) ? PENDING_POLL_MS : OPEN_POLL_MS;

const parseOutpoint = (id: string): Outpoint | null => {
  const [txid, vout] = id.split(':');
  if (txid === undefined || vout === undefined || !/^[0-9a-f]{64}$/.test(txid) || !/^\d+$/.test(vout))
    return null;
  return { txid, vout: Number(vout) };
};

/** Wallet session messages #1 and #2, from the connector's own events. */
function WalletSessionNotifications() {
  useEffect(() => {
    const center = getNotificationCenter();
    return getWalletConnector().onEvent((event) => {
      const sessionId = `wallet-${Date.now()}`;
      if (event.type === 'connected') {
        center.notify(
          walletConnected({ walletName: event.wallet.name, address: event.owner.address, sessionId }),
        );
      } else {
        center.notify(
          walletDisconnected({
            sessionId,
            byUser: event.byUser,
            reason: event.reason,
            message: event.message,
          }),
        );
      }
    });
  }, []);
  return null;
}

/**
 * Order polling and catch-up for the app shell (notifications.md "Data sources"): the connected
 * owner's orders through `GET /orders?address=`, plus orders this tab follows. A status change since
 * the last one this browser saw raises its message once (dedupe key `{orderId}:{status}`).
 */
function OrderNotifications() {
  const owner = ownerOf(useWalletState());
  const followedIds = useFollowedOrders();
  const followed = useMemo(
    () => followedIds.map(parseOutpoint).filter((outpoint): outpoint is Outpoint => outpoint !== null),
    [followedIds],
  );

  const owned = useQuery({
    ...queries.ordersByAddress(owner?.address ?? ''),
    enabled: owner !== null,
    refetchInterval: (query) => pollInterval(query.state.data),
  });
  const tracked = useQuery({
    ...queries.ordersByOutpoints(followed),
    enabled: followed.length > 0,
    refetchInterval: (query) => pollInterval(query.state.data),
  });

  const ownerPkh = owner?.ownerPkhHex ?? null;
  useEffect(() => {
    if (ownerPkh === null || owned.data === undefined) return;
    const center = getNotificationCenter();
    const seen = loadSeenStatuses(ownerPkh);
    const next: Record<string, OrderStatus> = { ...(seen ?? {}) };
    for (const order of owned.data) {
      if (seen !== null) {
        const context = { cancelSentHere: cancelWasSentHere(order.id) };
        for (const message of messagesForStatusChange(seen[order.id], order, context)) center.notify(message);
      }
      next[order.id] = order.status;
    }
    saveSeenStatuses(ownerPkh, next);
  }, [ownerPkh, owned.data]);

  const followedSeen = useRef(new Map<string, OrderStatus>());
  useEffect(() => {
    if (tracked.data === undefined) return;
    const center = getNotificationCenter();
    const ownedIds = new Set(owned.data?.map((order) => order.id) ?? []);
    for (const order of tracked.data) {
      const previous = followedSeen.current.get(order.id);
      followedSeen.current.set(order.id, order.status);
      if (ownedIds.has(order.id) || previous === undefined) continue;
      const context = { cancelSentHere: cancelWasSentHere(order.id) };
      for (const message of messagesForStatusChange(previous, order, context)) center.notify(message);
    }
  }, [tracked.data, owned.data]);

  return null;
}

export function NotificationBridge() {
  return (
    <>
      <WalletSessionNotifications />
      <OrderNotifications />
    </>
  );
}
