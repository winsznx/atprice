import { ownerPkhFromPublicKey, type UnsignedTransactionDraft, type WizardConnectSignRequest } from '@atprice/core';
import * as wizardCore from '@wizardconnect/core';
import type { DappRelayResult, RelayUpdatePayload, SignTransactionRequest, SignTransactionResponse } from '@wizardconnect/core';
import * as wizardDapp from '@wizardconnect/dapp';
import type { DappConnectionManager } from '@wizardconnect/dapp';
import { checkWizardConnectCompatibility } from '../../../web/lib/wallet/compatibility';
import { PAIRING_TIMEOUT_MS, PAIRING_WARNING_MS } from '../../../web/lib/wallet/constants';
import { WalletError } from '../../../web/lib/wallet/errors';
import { xpubNetwork, type XpubNetwork } from '../../../web/lib/wallet/keys';
import { WIZARDCONNECT_RELAYS, XPUB_NETWORK, type RecoverConfig } from '../config';
import { ownerAddressOf } from '../core/describe';
import { describeError } from '../core/errors';

export interface WalletIdentity {
  readonly name: string;
  readonly icon: string | null;
}

export interface OwnerKey {
  readonly ownerPkh: Uint8Array;
  readonly address: string;
}

/**
 * The DD 7.8 states as Recover renders them (recover.md "Connect (section 4)"). There is no
 * `resuming` or `wallet not answering`: the session is never stored, so there is nothing to resume.
 */
export type RecoverWalletState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly problems: readonly string[] }
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'pairing';
      readonly uri: string;
      readonly qrUri: string;
      readonly shownAt: number;
      readonly warningSince: number | null;
      readonly deadline: number;
    }
  | { readonly kind: 'pairing_timed_out' }
  | {
      readonly kind: 'connected';
      readonly wallet: WalletIdentity;
      readonly owner: OwnerKey;
      readonly reconnectingSince: number | null;
    }
  | {
      readonly kind: 'wrong_network';
      readonly wallet: WalletIdentity;
      readonly walletNetwork: XpubNetwork;
      readonly reconnectingSince: number | null;
    }
  | { readonly kind: 'missing_receive'; readonly wallet: WalletIdentity; readonly reconnectingSince: number | null }
  | { readonly kind: 'disconnected'; readonly reason: string; readonly message: string | null }
  | { readonly kind: 'error'; readonly message: string; readonly relayUnreachable: boolean };

type ConnectedFamily = Extract<RecoverWalletState, { reconnectingSince: number | null }>;

export const isConnectedFamily = (state: RecoverWalletState): state is ConnectedFamily =>
  state.kind === 'connected' || state.kind === 'wrong_network' || state.kind === 'missing_receive';

const RECEIVE_CHILD = 0;
const DAPP_NAME = 'AtPrice Recover';

/** core's relay-safe request is the wire format; the library types it as raw bytes (see apps/web connector). */
const asLibraryRequest = (request: WizardConnectSignRequest): Pick<SignTransactionRequest, 'transaction' | 'inputPaths'> =>
  request as unknown as Pick<SignTransactionRequest, 'transaction' | 'inputPaths'>;

/**
 * One WizardConnect pairing for Recover, in the browser file and the CLI. Built with
 * `session: false` (the library's `persistSession: false`): nothing is resumed from or written to
 * storage, so the website's own session is untouched and a shared computer keeps no pairing.
 */
export class RecoverWallet {
  private state: RecoverWalletState = { kind: 'loading' };
  private readonly listeners = new Set<() => void>();
  private manager: DappConnectionManager | undefined;
  private relay: DappRelayResult | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private generation = 0;
  private relayReached = false;

  constructor(private readonly config: Pick<RecoverConfig, 'network'>) {}

  getState = (): RecoverWalletState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(next: RecoverWalletState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Boot-time check of the pinned library (research/wizardconnect.md); failure is a named state. */
  start(): void {
    if (this.state.kind !== 'loading') return;
    const result = checkWizardConnectCompatibility({ core: wizardCore, dapp: wizardDapp }, WIZARDCONNECT_RELAYS);
    this.setState(result.ok ? { kind: 'idle' } : { kind: 'unavailable', problems: result.problems });
  }

  /** `Connect owner wallet`, `New pairing code`, `Connect again`, `Try again`. */
  async connect(): Promise<void> {
    await this.teardown();
    const generation = ++this.generation;
    this.relayReached = false;
    let manager: DappConnectionManager;
    let relay: DappRelayResult;
    try {
      manager = new wizardDapp.DappConnectionManager(DAPP_NAME, undefined, { session: false });
      relay = wizardCore.initiateDappRelay((payload) => this.onRelayStatus(generation, manager, payload), {
        explicitRelayUrls: [...WIZARDCONNECT_RELAYS],
      });
      manager.attachRelay(relay);
    } catch (error) {
      this.setState({ kind: 'error', message: describeError(error), relayUnreachable: false });
      return;
    }
    manager.on('walletready', () => {
      if (generation === this.generation) this.onWalletReady();
    });
    manager.on('reconnecting', () => {
      if (generation === this.generation) this.onReconnecting();
    });
    manager.on('messagereceived', () => {
      if (generation === this.generation) this.onAlive();
    });
    manager.on('disconnect', (reason, message) => {
      if (generation === this.generation) void this.onRemoteDisconnect(String(reason), message ?? null);
    });
    this.manager = manager;
    this.relay = relay;
    const now = Date.now();
    this.setState({
      kind: 'pairing',
      uri: relay.uri,
      qrUri: relay.qrUri,
      shownAt: now,
      warningSince: null,
      deadline: now + PAIRING_TIMEOUT_MS,
    });
    this.schedulePairingTimers();
  }

  private onRelayStatus(generation: number, manager: DappConnectionManager, payload: RelayUpdatePayload): void {
    manager.updateConnection(payload.client, payload.status);
    if (generation !== this.generation) return;
    if (payload.status.status === 'connected') {
      this.relayReached = true;
      return;
    }
    // Before the relay has ever answered, a reconnect with an error means it can't be reached at all.
    if (!this.relayReached && this.state.kind === 'pairing' && payload.status.status === 'reconnecting') {
      const detail = payload.status.error ?? 'no answer from the relay';
      void this.teardown().then(() => this.setState({ kind: 'error', message: detail, relayUnreachable: true }));
    }
  }

  private schedulePairingTimers(): void {
    this.clearTimers();
    const shownAt = Date.now();
    if (this.state.kind === 'pairing') {
      this.setState({ ...this.state, shownAt, deadline: shownAt + PAIRING_TIMEOUT_MS, warningSince: null });
    }
    this.timers.push(
      setTimeout(() => {
        if (this.state.kind === 'pairing') this.setState({ ...this.state, warningSince: Date.now() });
      }, PAIRING_TIMEOUT_MS - PAIRING_WARNING_MS),
      setTimeout(() => {
        if (this.state.kind === 'pairing') void this.teardown().then(() => this.setState({ kind: 'pairing_timed_out' }));
      }, PAIRING_TIMEOUT_MS),
    );
  }

  /** `Keep waiting`: restarts the 5-minute limit with the same code, any number of times. */
  keepWaiting(): void {
    if (this.state.kind === 'pairing') this.schedulePairingTimers();
  }

  /** `Cancel pairing`: awaits `destroy()` and `relay.cleanup()`, then idle. */
  async cancelPairing(): Promise<void> {
    await this.teardown();
    this.setState({ kind: 'idle' });
  }

  /** `Disconnect`: tells the wallet, closes the relay, back to idle. There is no stored session to clear. */
  async disconnect(): Promise<void> {
    const manager = this.manager;
    if (manager !== undefined) {
      try {
        await manager.sendDisconnect('The user disconnected AtPrice Recover.');
      } catch (error) {
        console.error('WizardConnect disconnect message failed to send:', error);
      }
    }
    await this.teardown();
    this.setState({ kind: 'idle' });
  }

  /** Every teardown awaits `destroy()` before `cleanup()`, so open sign requests are cancelled on the wire. */
  private async teardown(): Promise<void> {
    this.clearTimers();
    this.generation += 1;
    const manager = this.manager;
    const relay = this.relay;
    this.manager = undefined;
    this.relay = undefined;
    if (manager !== undefined) {
      try {
        await manager.destroy();
      } catch (error) {
        console.error('WizardConnect manager.destroy() failed:', error);
      }
      manager.removeAllListeners();
    }
    relay?.cleanup();
  }

  private identity(): WalletIdentity {
    return { name: this.manager?.walletName ?? 'Wallet', icon: this.manager?.walletIcon ?? null };
  }

  /** DD 7.8 checks on `walletready`, in order, before any address is derived. */
  private onWalletReady(): void {
    const manager = this.manager;
    if (manager === undefined) return;
    this.clearTimers();
    const wallet = this.identity();
    if (!manager.hasPath(RECEIVE_CHILD)) {
      this.setState({ kind: 'missing_receive', wallet, reconnectingSince: null });
      return;
    }
    const receive = manager.getSessionPaths().find((path) => path.name === 'receive');
    let network: XpubNetwork;
    try {
      if (receive === undefined) throw new Error('wallet_ready lists no receive xpub');
      network = xpubNetwork(receive.xpub);
    } catch (error) {
      this.setState({ kind: 'error', message: describeError(error), relayUnreachable: false });
      return;
    }
    if (network !== XPUB_NETWORK[this.config.network]) {
      this.setState({ kind: 'wrong_network', wallet, walletNetwork: network, reconnectingSince: null });
      return;
    }
    const receive0 = manager.getPubkey(RECEIVE_CHILD, 0n);
    if (receive0 === undefined) {
      this.setState({ kind: 'missing_receive', wallet, reconnectingSince: null });
      return;
    }
    try {
      const ownerPkh = ownerPkhFromPublicKey(receive0);
      this.setState({
        kind: 'connected',
        wallet,
        owner: { ownerPkh, address: ownerAddressOf(ownerPkh, this.config.network) },
        reconnectingSince: null,
      });
    } catch (error) {
      this.setState({ kind: 'error', message: describeError(error), relayUnreachable: false });
    }
  }

  private onReconnecting(): void {
    const state = this.state;
    if (isConnectedFamily(state) && state.reconnectingSince === null) {
      this.setState({ ...state, reconnectingSince: Date.now() });
    }
  }

  private onAlive(): void {
    const state = this.state;
    if (isConnectedFamily(state) && state.reconnectingSince !== null) this.setState({ ...state, reconnectingSince: null });
  }

  private async onRemoteDisconnect(reason: string, message: string | null): Promise<void> {
    await this.teardown();
    this.setState({ kind: 'disconnected', reason, message });
  }

  /**
   * Sends a core draft with `broadcast: false` and returns the wallet's signed hex. No time limit (DD
   * 7.8): it waits until the wallet answers, the session ends or `signal` aborts.
   */
  async requestSignature(draft: UnsignedTransactionDraft, signal?: AbortSignal): Promise<string> {
    const manager = this.manager;
    if (manager === undefined || this.state.kind !== 'connected') {
      throw new WalletError('WALLET_NOT_READY', 'No connected wallet can sign this transaction.');
    }
    let response: SignTransactionResponse;
    try {
      response = await manager.signTransaction(asLibraryRequest(draft.request), signal === undefined ? undefined : { signal });
    } catch (error) {
      if (signal?.aborted) {
        throw new WalletError('SIGN_REQUEST_CANCELLED', 'You cancelled the request. Nothing was sent.', { cause: error });
      }
      throw new WalletError('WALLET_SESSION_ENDED', 'The wallet session ended while the request was open.', { cause: error });
    }
    if (response.error !== undefined && response.error !== '') throw new WalletError('WALLET_DECLINED', response.error);
    if (response.signedTransaction === '') {
      throw new WalletError('WALLET_DECLINED', 'The wallet returned no signed transaction.');
    }
    return response.signedTransaction;
  }
}
