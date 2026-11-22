import { describe, expect, it, vi } from 'vitest';
import { NotificationCenter, type SessionStore } from './center';
import { fundingSent, walletConnected } from './messages';
import type { AppNotification, RecordedNotification } from './types';

const memory = (): SessionStore & { saved: readonly RecordedNotification[] } => {
  const store = {
    saved: [] as readonly RecordedNotification[],
    load: () => [],
    save: (entries: readonly RecordedNotification[]) => {
      store.saved = entries;
    },
  };
  return store;
};

const chainEvent = (id: string): AppNotification => ({
  id,
  ref: '8',
  kind: 'chain',
  icon: 'filled',
  title: 'Order filled',
  body: 'You received 230.00 PUSD for 0.50 BCH.',
  meta: 'Confirmed in block 925,118',
  txid: null,
  address: null,
  actions: [],
  durationMs: 10_000,
  flow: null,
  createdAt: 0,
});

describe('NotificationCenter (DD 7.10)', () => {
  it('raises at once when no modal is open and records the delivery', () => {
    const store = memory();
    const center = new NotificationCenter(store);
    const raise = vi.fn();
    center.attachRaiser(raise);
    center.notify(chainEvent('o1:FILLED'));
    expect(raise).toHaveBeenCalledTimes(1);
    expect(store.saved[0]?.delivery).toBe('raised');
  });

  it('queues messages while any modal is open and raises them in order when the last closes', () => {
    const center = new NotificationCenter(memory());
    const raised: string[] = [];
    center.attachRaiser((notification) => raised.push(notification.id));
    const closePanel = center.openModal('wallet-panel');
    const closeMenu = center.openModal('menu');
    center.notify(chainEvent('a'));
    center.notify(chainEvent('b'));
    closePanel();
    expect(raised).toEqual([]);
    closeMenu();
    expect(raised).toEqual(['a', 'b']);
  });

  it('shows a flow message in its own dialog instead of raising or queueing it', () => {
    const store = memory();
    const center = new NotificationCenter(store);
    const raise = vi.fn();
    center.attachRaiser(raise);
    const close = center.openModal('connect');
    center.notify(walletConnected({ walletName: 'Paytaca', address: 'bchtest:qexample', sessionId: 's1' }));
    close();
    expect(raise).not.toHaveBeenCalled();
    expect(store.saved[0]?.delivery).toBe('dialog');
  });

  it('queues a flow message that belongs to a different order than the open dialog', () => {
    const center = new NotificationCenter(memory());
    const raise = vi.fn();
    center.attachRaiser(raise);
    const close = center.openModal('funding', 'draft-1');
    center.notify(fundingSent({ draftId: 'draft-2', txid: 'f'.repeat(64), amountText: '0.50 BCH' }));
    expect(raise).not.toHaveBeenCalled();
    close();
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('shows each dedupe key once', () => {
    const center = new NotificationCenter(memory());
    const raise = vi.fn();
    center.attachRaiser(raise);
    center.notify(chainEvent('o1:FILLED'));
    center.notify(chainEvent('o1:FILLED'));
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('raises a closing flow dialog’s attempt toast after recording it once', () => {
    const store = memory();
    const center = new NotificationCenter(store);
    const raise = vi.fn();
    center.attachRaiser(raise);
    const message = fundingSent({ draftId: 'd', txid: 'e'.repeat(64), amountText: '0.50 BCH' });
    const close = center.openModal('funding', 'd');
    center.notify(message);
    close();
    center.raiseOnClose(message);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(store.saved).toHaveLength(1);
  });

  it('clears the session list without letting a cleared message come back', () => {
    const store = memory();
    const center = new NotificationCenter(store);
    const raise = vi.fn();
    const listener = vi.fn();
    center.attachRaiser(raise);
    center.subscribe(listener);
    center.notify(chainEvent('o1:FILLED'));
    center.clear();
    expect(center.getEntries()).toEqual([]);
    expect(store.saved).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    center.notify(chainEvent('o1:FILLED'));
    expect(center.getEntries()).toEqual([]);
    expect(raise).toHaveBeenCalledTimes(1);
  });
});
