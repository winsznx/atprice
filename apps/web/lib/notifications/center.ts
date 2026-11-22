import type { AppNotification, MessageFlow, ModalKind, RecordedNotification } from './types';

/*
 * The NotificationCenter of DD 7.10, framework-free. It decides, for every message, whether it is
 * shown by the open dialog that owns it, queued behind an open modal, or raised as a toast now, and it
 * records every message in the session list the moment it is created, so nothing is ever dropped.
 */

export type Raise = (notification: AppNotification) => void;

interface OpenModal {
  readonly token: symbol;
  readonly kind: ModalKind;
  readonly subject: string | null;
}

const MAX_RECORDED = 200;

const recordable = (
  notification: AppNotification,
  delivery: RecordedNotification['delivery'],
): RecordedNotification => ({
  ...notification,
  actions: notification.actions.flatMap((action) =>
    'href' in action ? [{ label: action.label, href: action.href }] : [],
  ),
  delivery,
});

const ownsFlow = (modal: OpenModal, flow: MessageFlow): boolean =>
  modal.kind === flow.kind &&
  (flow.subject === null || modal.subject === null || modal.subject === flow.subject);

export interface SessionStore {
  load(): readonly RecordedNotification[];
  save(entries: readonly RecordedNotification[]): void;
}

export class NotificationCenter {
  private entries: readonly RecordedNotification[];
  private readonly seen = new Set<string>();
  private readonly modals: OpenModal[] = [];
  private queue: AppNotification[] = [];
  private raiser: Raise | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: SessionStore) {
    this.entries = storage.load();
    for (const entry of this.entries) this.seen.add(entry.id);
  }

  getEntries = (): readonly RecordedNotification[] => this.entries;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The Toaster registers how a toast is raised; until then, messages queue. */
  attachRaiser(raise: Raise): () => void {
    this.raiser = raise;
    this.flush();
    return () => {
      if (this.raiser === raise) this.raiser = null;
    };
  }

  get modalOpen(): boolean {
    return this.modals.length > 0;
  }

  /**
   * Call when a modal opens; call the returned function when it closes. Flow dialogs pass the order
   * or draft they are about, so only their own messages are shown in the dialog instead of raised.
   */
  openModal(kind: ModalKind, subject: string | null = null): () => void {
    const token = Symbol(kind);
    this.modals.push({ token, kind, subject });
    return () => {
      const index = this.modals.findIndex((modal) => modal.token === token);
      if (index >= 0) this.modals.splice(index, 1);
      if (this.modals.length === 0) this.flush();
    };
  }

  /** True when this exact message was already created in this session (dedupe by id). */
  has(id: string): boolean {
    return this.seen.has(id);
  }

  notify(notification: AppNotification): void {
    if (this.seen.has(notification.id)) return;
    this.seen.add(notification.id);
    const owner =
      notification.flow === null
        ? undefined
        : this.modals.find((modal) => notification.flow !== null && ownsFlow(modal, notification.flow));
    if (owner !== undefined) {
      this.record(recordable(notification, 'dialog'));
      return;
    }
    if (this.modals.length > 0 || this.raiser === null) {
      this.record(recordable(notification, 'queued'));
      this.queue.push(notification);
      return;
    }
    this.record(recordable(notification, 'raised'));
    this.raiser(notification);
  }

  /**
   * Raises a message as its flow dialog closes (`Funding sent`, `Cancel sent`, #12, #15): the dialog
   * showed the state while open, so it is already recorded; the toast is raised now.
   */
  raiseOnClose(notification: AppNotification): void {
    if (!this.seen.has(notification.id)) {
      this.seen.add(notification.id);
      this.record(recordable(notification, 'raised'));
    }
    if (this.raiser === null || this.modals.length > 0) this.queue.push(notification);
    else this.raiser(notification);
  }

  /**
   * Empties the session list (activity.md `Clear session list`). Dedupe keys stay, so a message this
   * session already created isn't recreated by the next order poll and doesn't come back as a toast.
   */
  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.storage.save(this.entries);
    for (const listener of this.listeners) listener();
  }

  private flush(): void {
    if (this.raiser === null || this.modals.length > 0) return;
    const pending = this.queue;
    this.queue = [];
    for (const notification of pending) this.raiser(notification);
  }

  private record(entry: RecordedNotification): void {
    this.entries = [entry, ...this.entries].slice(0, MAX_RECORDED);
    this.storage.save(this.entries);
    for (const listener of this.listeners) listener();
  }
}
