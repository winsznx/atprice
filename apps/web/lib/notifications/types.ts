/** DD 7.10 kinds: attempt (asked or sent), chain event (observed), failure, wallet session. */
export type NoticeKind = 'attempt' | 'chain' | 'failure' | 'session';

/** Icons by meaning; `Notice` maps each to its Phosphor glyph (DD 7.10 "Kinds", DD 12). */
export type NoticeIcon =
  'hourglass' | 'send' | 'filled' | 'cancelled' | 'failed' | 'review' | 'link' | 'unlink';

/** A dialog flow that owns some messages (notifications.md "Flow ownership"). */
export type FlowKind = 'connect' | 'funding' | 'cancel';

/** Any modal that holds toasts back while open (DD 7.10). */
export type ModalKind = FlowKind | 'wallet-panel' | 'menu';

export interface MessageFlow {
  readonly kind: FlowKind;
  /** The order or draft the flow is about; a flow message for another order is queued, not swallowed. */
  readonly subject: string | null;
}

export type NoticeAction =
  { readonly label: string; readonly href: string } | { readonly label: string; readonly run: () => void };

export interface AppNotification {
  /** Dedupe key, passed as the Sonner toast id: `{orderId}:{status}` or `{session}:{event}`. */
  readonly id: string;
  /** Row of the notifications.md Messages table (`1`, `5+6`, `11c`, ...). */
  readonly ref: string;
  readonly kind: NoticeKind;
  readonly icon: NoticeIcon;
  readonly title: string;
  readonly body: string;
  /** `Not confirmed yet`, `Confirmed in block {h}`, a named reason. Spoken with the toast. */
  readonly meta: string | null;
  readonly txid: string | null;
  readonly address: string | null;
  readonly actions: readonly NoticeAction[];
  /** Auto-dismiss after this many ms; null means persistent until dismissed. */
  readonly durationMs: number | null;
  readonly flow: MessageFlow | null;
  readonly createdAt: number;
}

/** What the session list keeps (Activity "Session notifications"); actions that run code don't survive a reload. */
export interface RecordedNotification extends Omit<AppNotification, 'actions'> {
  readonly actions: readonly { readonly label: string; readonly href: string }[];
  /** How it reached the user: raised as a toast, shown by its dialog, or held until a modal closed. */
  readonly delivery: 'raised' | 'dialog' | 'queued';
}
