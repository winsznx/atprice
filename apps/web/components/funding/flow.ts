import { bytesEqual, type FundingDraft, type SignedTransaction, type WalletUtxo } from '@atprice/core';
import type { Registration } from '@/lib/api/schemas';
import { BROADCAST_TIMEOUT_MS } from '@/lib/wallet/constants';
import { isWalletError } from '@/lib/wallet/errors';
import type { BroadcastOutcome } from '@/lib/wallet/sign';
import type { FundingPreview } from './fees';

/*
 * The funding confirmation's flow (funding-confirmation.md "Flow states"), framework-free so every
 * transition is tested without a browser. React reads it through `useSyncExternalStore`.
 */

/** `register failed` retries this often while the tab is open (funding-confirmation.md). */
export const REGISTER_RETRY_MS = 15_000;

export type UpdatedRow = 'kept' | 'leaves' | 'funding_fee';

export interface Shortfall {
  readonly needed: bigint;
  readonly available: bigint;
}

export type FundingPhase =
  | { readonly kind: 'building' }
  | { readonly kind: 'utxo_error'; readonly code: string; readonly host: string | null }
  | { readonly kind: 'build_error'; readonly code: string; readonly message: string }
  | {
      readonly kind: 'review';
      readonly draft: FundingDraft | null;
      readonly shortfall: Shortfall | null;
      readonly coinsChanged: boolean;
      readonly updated: readonly UpdatedRow[];
      readonly stoppedWaiting: boolean;
    }
  | { readonly kind: 'awaiting_signature'; readonly draft: FundingDraft; readonly since: number }
  | { readonly kind: 'rejected'; readonly draft: FundingDraft }
  | {
      readonly kind: 'signing_error';
      readonly draft: FundingDraft;
      readonly code: string;
      readonly reason: string;
    }
  | { readonly kind: 'signed_changed'; readonly difference: string }
  | { readonly kind: 'draft_changed' }
  | {
      readonly kind: 'broadcasting';
      readonly signed: SignedTransaction;
      readonly since: number;
      readonly host: string | null;
    }
  | {
      readonly kind: 'broadcast_unknown';
      readonly signed: SignedTransaction;
      readonly check: 'idle' | 'checking' | 'not_found' | { readonly error: string };
    }
  | { readonly kind: 'broadcast_rejected'; readonly message: string }
  | { readonly kind: 'registering'; readonly txid: string }
  | { readonly kind: 'register_failed'; readonly txid: string; readonly code: string }
  | { readonly kind: 'registered'; readonly txid: string; readonly registration: Registration };

export type FundingEvent =
  /** The dialog reached `review` with a built transaction: the draft pointer is written then. */
  | { readonly type: 'review_ready' }
  | { readonly type: 'awaiting_signature' }
  | { readonly type: 'declined' }
  | {
      readonly type: 'not_sent';
      readonly code: 'WALLET_SESSION_ENDED' | 'SIGNED_TX_MISMATCH';
      readonly reason: string;
    }
  | { readonly type: 'broadcast_rejected'; readonly message: string }
  | { readonly type: 'signed'; readonly signed: SignedTransaction }
  | { readonly type: 'funding_sent'; readonly txid: string }
  | { readonly type: 'register_failed'; readonly txid: string; readonly code: string }
  | { readonly type: 'broadcast_unknown'; readonly txid: string }
  | { readonly type: 'registered'; readonly txid: string };

type TimerHandle = ReturnType<typeof setTimeout>;

export interface FundingDeps {
  /** Fresh wallet UTXOs with their `(path, index)` (trade.md). */
  readonly scanUtxos: () => Promise<readonly WalletUtxo[]>;
  /** The printed code and host of a failed UTXO read (`ELECTRUM_UNREACHABLE`). */
  readonly scanErrorCode: (error: unknown) => string;
  /** Core's funding builder over these UTXOs, for the parameters shown in the dialog. */
  readonly build: (utxos: readonly WalletUtxo[]) => FundingPreview;
  /** The order locking bytecode derived at review; a draft paying anything else is `DRAFT_CHANGED`. */
  readonly expectedOrderLocking: Uint8Array;
  readonly sign: (draft: FundingDraft, signal: AbortSignal) => Promise<SignedTransaction>;
  readonly broadcast: (signed: SignedTransaction) => Promise<BroadcastOutcome>;
  /** True when the txid is in the mempool or chain of the current (or failover) Electrum server. */
  readonly seen: (txid: string) => Promise<boolean>;
  readonly register: (txid: string) => Promise<Registration>;
  readonly registerErrorCode: (error: unknown) => string;
  readonly endpointLabel: () => string | null;
  readonly onEvent: (event: FundingEvent) => void;
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
}

const outpoints = (utxos: readonly WalletUtxo[]): string =>
  utxos
    .map((utxo) => `${utxo.txid}:${utxo.vout}`)
    .sort()
    .join(',');

const changedRows = (before: FundingDraft | null, after: FundingDraft): UpdatedRow[] => {
  if (before === null) return [];
  const rows: UpdatedRow[] = [];
  if (before.ownerOutputSatoshis !== after.ownerOutputSatoshis) rows.push('kept');
  if (before.fee !== after.fee) rows.push('funding_fee', 'leaves');
  return rows;
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class FundingFlow {
  private phase: FundingPhase = { kind: 'building' };
  private readonly listeners = new Set<() => void>();
  private utxos: readonly WalletUtxo[] = [];
  private lastDraft: FundingDraft | null = null;
  private signRequest: AbortController | null = null;
  private generation = 0;
  private broadcastTimer: TimerHandle | null = null;
  private registerTimer: TimerHandle | null = null;
  private disposed = false;
  private stopped = false;

  constructor(private readonly deps: FundingDeps) {}

  getPhase = (): FundingPhase => this.phase;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: FundingPhase): void {
    if (this.disposed) return;
    this.phase = next;
    for (const listener of this.listeners) listener();
  }

  /** Reads the wallet's coins and builds the funding transaction (`building`, then `review`). */
  async build(options: { readonly coinsChanged?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    if (!options.coinsChanged) this.set({ kind: 'building' });
    let utxos: readonly WalletUtxo[];
    try {
      utxos = await this.deps.scanUtxos();
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ kind: 'utxo_error', code: this.deps.scanErrorCode(error), host: this.deps.endpointLabel() });
      return;
    }
    if (generation !== this.generation) return;
    this.applyBuild(utxos, options.coinsChanged === true);
  }

  private applyBuild(utxos: readonly WalletUtxo[], coinsChanged: boolean): void {
    this.utxos = utxos;
    const preview = this.deps.build(utxos);
    const previous = this.lastDraft;
    switch (preview.kind) {
      case 'ok':
        if (!bytesEqual(preview.draft.orderLockingBytecode, this.deps.expectedOrderLocking)) {
          this.set({ kind: 'draft_changed' });
          return;
        }
        this.lastDraft = preview.draft;
        this.set({
          kind: 'review',
          draft: preview.draft,
          shortfall: null,
          coinsChanged,
          updated: coinsChanged ? changedRows(previous, preview.draft) : [],
          stoppedWaiting: false,
        });
        this.deps.onEvent({ type: 'review_ready' });
        return;
      case 'short':
        this.set({
          kind: 'review',
          draft: previous,
          shortfall: { needed: preview.required, available: preview.available },
          coinsChanged,
          updated: [],
          stoppedWaiting: false,
        });
        return;
      case 'invalid':
        this.set({
          kind: 'build_error',
          code: preview.error.reason.toUpperCase(),
          message: preview.error.message,
        });
    }
  }

  /**
   * `Confirm and sign in wallet`: the pre-sign UTXO refresh, then the sign request at once. Coins that
   * changed since review rebuild the transaction and stop for a second look (`coins changed`).
   */
  async confirm(): Promise<void> {
    const phase = this.phase;
    if (phase.kind !== 'review' || phase.draft === null || phase.shortfall !== null) return;
    const draft = phase.draft;
    const generation = ++this.generation;
    let fresh: readonly WalletUtxo[];
    try {
      fresh = await this.deps.scanUtxos();
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ kind: 'utxo_error', code: this.deps.scanErrorCode(error), host: this.deps.endpointLabel() });
      return;
    }
    if (generation !== this.generation) return;
    if (outpoints(fresh) !== outpoints(this.utxos)) {
      this.applyBuild(fresh, true);
      return;
    }
    this.requestSignature(draft, generation);
  }

  private requestSignature(draft: FundingDraft, generation: number): void {
    const request = new AbortController();
    this.signRequest = request;
    this.set({ kind: 'awaiting_signature', draft, since: this.deps.now() });
    this.deps.onEvent({ type: 'awaiting_signature' });
    this.deps.sign(draft, request.signal).then(
      (signed) => {
        if (generation !== this.generation || request.signal.aborted) return;
        this.signRequest = null;
        this.deps.onEvent({ type: 'signed', signed });
        void this.send(signed);
      },
      (error: unknown) => {
        if (generation !== this.generation || request.signal.aborted) return;
        this.signRequest = null;
        this.signFailed(draft, error);
      },
    );
  }

  private signFailed(draft: FundingDraft, error: unknown): void {
    if (isWalletError(error)) {
      switch (error.code) {
        case 'WALLET_DECLINED':
          this.set({ kind: 'rejected', draft });
          this.deps.onEvent({ type: 'declined' });
          return;
        case 'SIGNED_TX_MISMATCH':
          this.set({ kind: 'signed_changed', difference: error.message });
          this.deps.onEvent({ type: 'not_sent', code: 'SIGNED_TX_MISMATCH', reason: error.message });
          return;
        case 'SIGN_REQUEST_CANCELLED':
          return;
        default:
          this.set({ kind: 'signing_error', draft, code: error.code, reason: error.message });
          this.deps.onEvent({ type: 'not_sent', code: 'WALLET_SESSION_ENDED', reason: error.message });
          return;
      }
    }
    this.set({ kind: 'signing_error', draft, code: 'WIZARDCONNECT_ERROR', reason: describe(error) });
    this.deps.onEvent({ type: 'not_sent', code: 'WALLET_SESSION_ENDED', reason: describe(error) });
  }

  /** `Cancel request`: stop waiting and ignore any later answer to this request. */
  cancelRequest(): void {
    if (this.phase.kind !== 'awaiting_signature') return;
    const draft = this.phase.draft;
    this.generation += 1;
    this.signRequest?.abort();
    this.signRequest = null;
    this.set({
      kind: 'review',
      draft,
      shortfall: null,
      coinsChanged: false,
      updated: [],
      stoppedWaiting: true,
    });
  }

  /** `Try again` after a decline, a session error or a rejected broadcast: fresh coins, back to review. */
  tryAgain(): Promise<void> {
    return this.build();
  }

  private async send(signed: SignedTransaction): Promise<void> {
    const generation = ++this.generation;
    this.set({ kind: 'broadcasting', signed, since: this.deps.now(), host: this.deps.endpointLabel() });
    this.clearBroadcastTimer();
    this.broadcastTimer = this.deps.setTimer(() => {
      this.broadcastTimer = null;
      if (generation !== this.generation || this.phase.kind !== 'broadcasting') return;
      this.set({ kind: 'broadcast_unknown', signed, check: 'idle' });
      this.deps.onEvent({ type: 'broadcast_unknown', txid: signed.txid });
    }, BROADCAST_TIMEOUT_MS);
    const outcome = await this.deps.broadcast(signed);
    this.clearBroadcastTimer();
    if (generation !== this.generation) return;
    const phase = this.phase;
    // A late answer after the timeout still counts unless the user has started a check of their own.
    if (phase.kind !== 'broadcasting' && !(phase.kind === 'broadcast_unknown' && phase.check === 'idle'))
      return;
    switch (outcome.kind) {
      case 'accepted':
        this.fundingSent(outcome.txid);
        return;
      case 'rejected':
        this.set({ kind: 'broadcast_rejected', message: outcome.detail });
        this.deps.onEvent({ type: 'broadcast_rejected', message: outcome.detail });
        return;
      case 'unknown':
        if (phase.kind === 'broadcasting') {
          this.set({ kind: 'broadcast_unknown', signed, check: 'idle' });
          this.deps.onEvent({ type: 'broadcast_unknown', txid: signed.txid });
        }
    }
  }

  /** `Check again`: looks the txid up; found means funding sent, not found offers `Broadcast again`. */
  async checkAgain(): Promise<void> {
    const phase = this.phase;
    if (phase.kind !== 'broadcast_unknown') return;
    const generation = ++this.generation;
    this.set({ ...phase, check: 'checking' });
    let found: boolean;
    try {
      found = await this.deps.seen(phase.signed.txid);
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ ...phase, check: { error: this.deps.scanErrorCode(error) } });
      return;
    }
    if (generation !== this.generation) return;
    if (found) this.fundingSent(phase.signed.txid);
    else this.set({ ...phase, check: 'not_found' });
  }

  /** `Broadcast again`: resends the same signed bytes. */
  broadcastAgain(): Promise<void> {
    const phase = this.phase;
    if (phase.kind !== 'broadcast_unknown' || phase.check !== 'not_found') return Promise.resolve();
    return this.send(phase.signed);
  }

  private fundingSent(txid: string): void {
    this.deps.onEvent({ type: 'funding_sent', txid });
    void this.register(txid);
  }

  /**
   * Registration keeps its own loop: it is the one step that goes on after the dialog closes, because
   * the order is already funded on chain and the app retries while the tab is open.
   */
  private async register(txid: string): Promise<void> {
    this.generation += 1;
    if (this.phase.kind !== 'register_failed') this.set({ kind: 'registering', txid });
    try {
      const registration = await this.deps.register(txid);
      this.set({ kind: 'registered', txid, registration });
      this.deps.onEvent({ type: 'registered', txid });
    } catch (error) {
      if (this.stopped) return;
      const code = this.deps.registerErrorCode(error);
      const first = this.phase.kind !== 'register_failed';
      this.set({ kind: 'register_failed', txid, code });
      if (first) this.deps.onEvent({ type: 'register_failed', txid, code });
      this.registerTimer = this.deps.setTimer(() => {
        this.registerTimer = null;
        void this.register(txid);
      }, REGISTER_RETRY_MS);
    }
  }

  private clearBroadcastTimer(): void {
    if (this.broadcastTimer !== null) this.deps.clearTimer(this.broadcastTimer);
    this.broadcastTimer = null;
  }

  /**
   * Closing the dialog: stop timers and ignore every pending answer. A registration in progress keeps
   * retrying until it succeeds; `stop()` ends that too (the tab is going away).
   */
  dispose(): void {
    this.generation += 1;
    this.signRequest?.abort();
    this.clearBroadcastTimer();
    this.disposed = true;
  }

  stop(): void {
    this.dispose();
    this.stopped = true;
    if (this.registerTimer !== null) this.deps.clearTimer(this.registerTimer);
  }
}

/** The txid on screen from the moment the signed transaction passes its check. */
export const phaseTxid = (phase: FundingPhase): string | null => {
  switch (phase.kind) {
    case 'broadcasting':
    case 'broadcast_unknown':
      return phase.signed.txid;
    case 'registering':
    case 'register_failed':
    case 'registered':
      return phase.txid;
    default:
      return null;
  }
};

/** Close `x`, Escape and scrim are blocked while the wallet is asked and during the first 20 s of a broadcast. */
export const closeBlockedReason = (phase: FundingPhase, elapsedText: string): string | null => {
  if (phase.kind === 'awaiting_signature') return 'Wait until your wallet answers or cancel the request.';
  if (phase.kind === 'broadcasting') {
    return `Sending · ${elapsedText}. You can close once the network answers or after 20 s.`;
  }
  return null;
};

/** PRD 14 order state each phase stands for (DRAFT has no badge; null where no badge is shown). */
export const phaseOrderState = (phase: FundingPhase): 'AWAITING_SIGNATURE' | 'FUNDING_PENDING' | null => {
  switch (phase.kind) {
    case 'awaiting_signature':
      return 'AWAITING_SIGNATURE';
    case 'broadcasting':
    case 'registering':
    case 'register_failed':
    case 'registered':
      return 'FUNDING_PENDING';
    default:
      return null;
  }
};
