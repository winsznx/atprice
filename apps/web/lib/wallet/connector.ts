import type { DappRelayResult, SignTransactionRequest, SignTransactionResponse } from '@wizardconnect/core';
import type * as WizardConnectCore from '@wizardconnect/core';
import type { DappConnectionManager } from '@wizardconnect/dapp';
import type * as WizardConnectDapp from '@wizardconnect/dapp';
import type { UnsignedTransactionDraft, WalletPathName, WizardConnectSignRequest } from '@atprice/core';
import type { NetworkConfig } from '../network';
import { checkWizardConnectCompatibility } from './compatibility';
import {
  DAPP_NAME,
  PAIRING_TIMEOUT_MS,
  PAIRING_WARNING_MS,
  RESTORE_TIMEOUT_MS,
  SESSION_KEY,
} from './constants';
import { WalletError } from './errors';
import { ownerIdentity, walletNetworkLabel, xpubNetwork, type OwnerIdentity, type XpubNetwork } from './keys';

export interface WalletIdentity {
  readonly name: string;
  readonly icon: string | null;
}

/**
 * Every pairing state of DD 7.8, each entered by a real library state or event or a named AtPrice
 * timer. `reconnectingSince` is the library's `reconnecting` state layered on a session that already
 * reached `wallet_ready`.
 */
export type WalletState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly problems: readonly string[] }
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'pairing';
      readonly uri: string;
      readonly qrUri: string;
      readonly shownAt: number;
      /** Set once `PAIRING_WARNING_MS` before the limit has passed: "pairing about to stop". */
      readonly warningSince: number | null;
      readonly deadline: number;
    }
  | { readonly kind: 'pairing_timed_out' }
  | { readonly kind: 'resuming'; readonly since: number; readonly notAnswering: boolean }
  | {
      readonly kind: 'connected';
      readonly wallet: WalletIdentity;
      readonly owner: OwnerIdentity;
      readonly reconnectingSince: number | null;
    }
  | {
      readonly kind: 'wrong_network';
      readonly wallet: WalletIdentity;
      readonly walletNetwork: XpubNetwork;
      readonly reconnectingSince: number | null;
    }
  | {
      readonly kind: 'missing_receive';
      readonly wallet: WalletIdentity;
      readonly reconnectingSince: number | null;
    }
  | {
      readonly kind: 'disconnected';
      readonly byUser: boolean;
      readonly reason: string | null;
      readonly message: string | null;
    }
  | { readonly kind: 'error'; readonly message: string };

export type WalletEvent =
  | { readonly type: 'connected'; readonly wallet: WalletIdentity; readonly owner: OwnerIdentity }
  | {
      readonly type: 'disconnected';
      readonly byUser: boolean;
      readonly reason: string | null;
      readonly message: string | null;
    };

type CoreModule = typeof WizardConnectCore;
type DappModule = typeof WizardConnectDapp;

const PATH_CHILD: Readonly<Record<WalletPathName, number>> = { receive: 0, change: 1, defi: 7 };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The library types request bytes as `Uint8Array` and amounts as `bigint`, but its relay sends the
 * request through plain `JSON.stringify`, where those would throw or mangle. The wire format is the
 * relay-safe encoding (hex strings, `<bigint: Xn>`), which is exactly what `@atprice/core` produces;
 * so the core request is handed over as the library's parameter type in this one place.
 */
const asLibraryRequest = (
  request: WizardConnectSignRequest,
): Pick<SignTransactionRequest, 'transaction' | 'inputPaths'> =>
  request as unknown as Pick<SignTransactionRequest, 'transaction' | 'inputPaths'>;

/**
 * The tab's one WizardConnect session (research/wizardconnect.md section 11: one manager per tab).
 * Browser only, created lazily by `lib/wallet/store.ts`. Every teardown awaits `destroy()` before
 * `relay.cleanup()` so pending sign requests are cancelled on the wire (section 9).
 */
export class WalletConnector {
  private state: WalletState = { kind: 'loading' };
  private readonly stateListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: WalletEvent) => void>();
  private core: CoreModule | undefined;
  private dapp: DappModule | undefined;
  private manager: DappConnectionManager | undefined;
  private relay: DappRelayResult | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private generation = 0;
  private started = false;

  constructor(private readonly config: NetworkConfig) {}

  getState = (): WalletState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  onEvent(listener: (event: WalletEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private setState(next: WalletState): void {
    this.state = next;
    for (const listener of this.stateListeners) listener();
  }

  private emit(event: WalletEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Loads the library, runs the compatibility check, and resumes a stored session. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const [core, dapp] = await Promise.all([import('@wizardconnect/core'), import('@wizardconnect/dapp')]);
      const result = checkWizardConnectCompatibility({ core, dapp }, this.config.wizardConnectRelays);
      if (!result.ok) {
        this.setState({ kind: 'unavailable', problems: result.problems });
        return;
      }
      this.core = core;
      this.dapp = dapp;
    } catch (error) {
      this.setState({ kind: 'unavailable', problems: [`the library failed to load: ${describe(error)}`] });
      return;
    }
    const stored = this.storedSession();
    if (stored === null) {
      this.setState({ kind: 'idle' });
      return;
    }
    this.resume(stored);
  }

  private storedSession(): { privateKey: string; secret: string; walletPublicKey: string } | null {
    if (this.dapp === undefined) return null;
    let stored: ReturnType<DappModule['loadSession']>;
    try {
      stored = this.dapp.loadSession(SESSION_KEY);
    } catch (error) {
      console.error('Could not read the stored WizardConnect session:', error);
      return null;
    }
    if (stored?.walletPublicKey === undefined) return null;
    return { privateKey: stored.privateKey, secret: stored.secret, walletPublicKey: stored.walletPublicKey };
  }

  private requireModules(): { core: CoreModule; dapp: DappModule } {
    if (this.core === undefined || this.dapp === undefined) {
      throw new WalletError('WIZARDCONNECT_UNAVAILABLE', 'Wallet connection is unavailable in this build.');
    }
    return { core: this.core, dapp: this.dapp };
  }

  private open(existing?: { privateKey: string; secret: string; walletPublicKey: string }): number {
    const { core, dapp } = this.requireModules();
    const generation = ++this.generation;
    const manager = new dapp.DappConnectionManager(DAPP_NAME, undefined, { session: { key: SESSION_KEY } });
    const relay = core.initiateDappRelay(
      (payload) => manager.updateConnection(payload.client, payload.status),
      {
        explicitRelayUrls: [...this.config.wizardConnectRelays],
        ...(existing === undefined ? {} : { existingCredentials: existing }),
      },
    );
    manager.attachRelay(relay);
    manager.on('walletready', () => {
      if (generation === this.generation) this.handleWalletReady();
    });
    manager.on('reconnecting', () => {
      if (generation === this.generation) this.handleReconnecting();
    });
    manager.on('messagereceived', () => {
      if (generation === this.generation) this.handleAlive();
    });
    manager.on('disconnect', (reason, message) => {
      if (generation === this.generation) void this.handleRemoteDisconnect(String(reason), message ?? null);
    });
    this.manager = manager;
    this.relay = relay;
    return generation;
  }

  private resume(stored: { privateKey: string; secret: string; walletPublicKey: string }): void {
    try {
      this.open(stored);
    } catch (error) {
      // 0.2.11 throws on a stored session with an invalid walletPublicKey: clear it so `Try again` pairs fresh.
      this.dapp?.clearSession(SESSION_KEY);
      this.setState({ kind: 'error', message: describe(error) });
      return;
    }
    const since = Date.now();
    this.setState({ kind: 'resuming', since, notAnswering: false });
    this.timers.push(
      setTimeout(() => {
        if (this.state.kind === 'resuming') this.setState({ ...this.state, notAnswering: true });
      }, RESTORE_TIMEOUT_MS),
    );
  }

  private schedulePairingTimers(): void {
    this.clearTimers();
    const shownAt = Date.now();
    const deadline = shownAt + PAIRING_TIMEOUT_MS;
    if (this.state.kind === 'pairing')
      this.setState({ ...this.state, shownAt, deadline, warningSince: null });
    this.timers.push(
      setTimeout(() => {
        if (this.state.kind === 'pairing') this.setState({ ...this.state, warningSince: Date.now() });
      }, PAIRING_TIMEOUT_MS - PAIRING_WARNING_MS),
      setTimeout(() => {
        if (this.state.kind === 'pairing')
          void this.teardown().then(() => this.setState({ kind: 'pairing_timed_out' }));
      }, PAIRING_TIMEOUT_MS),
    );
  }

  /** `Show pairing code`, `New pairing code`, `Connect again`, `Try again`. */
  async connect(): Promise<void> {
    await this.teardown();
    try {
      this.open();
    } catch (error) {
      this.setState({ kind: 'error', message: describe(error) });
      return;
    }
    const relay = this.relay;
    if (relay === undefined) return;
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

  /** `Keep waiting`: restarts both pairing timers, keeps the same code. */
  keepWaiting(): void {
    if (this.state.kind === 'pairing') this.schedulePairingTimers();
  }

  /** Closing the modal while a code is shown ends the pairing, so no half-open relay stays behind. */
  async cancelPairing(): Promise<void> {
    if (this.state.kind !== 'pairing' && this.state.kind !== 'pairing_timed_out') return;
    await this.teardown();
    this.dapp?.clearSession(SESSION_KEY);
    this.setState({ kind: 'idle' });
  }

  /** `Forget and pair again`. */
  async forgetAndPair(): Promise<void> {
    this.manager?.clearStoredSession();
    await this.connect();
  }

  /** `Disconnect`: clear the stored session, tell the wallet, close the relay. */
  async disconnect(): Promise<void> {
    const manager = this.manager;
    manager?.clearStoredSession();
    if (manager !== undefined) {
      try {
        await manager.sendDisconnect('The user disconnected AtPrice.');
      } catch (error) {
        console.error('WizardConnect disconnect message failed to send:', error);
      }
    }
    await this.teardown();
    this.setState({ kind: 'disconnected', byUser: true, reason: null, message: null });
    this.emit({ type: 'disconnected', byUser: true, reason: null, message: null });
  }

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

  private walletIdentity(): WalletIdentity {
    return { name: this.manager?.walletName ?? 'Wallet', icon: this.manager?.walletIcon ?? null };
  }

  private reconnectingSince(): number | null {
    const state = this.state;
    return state.kind === 'connected' || state.kind === 'wrong_network' || state.kind === 'missing_receive'
      ? state.reconnectingSince
      : null;
  }

  /** DD 7.8 checks on `walletready`, in order, before any address is derived or shown. */
  private handleWalletReady(): void {
    const manager = this.manager;
    if (manager === undefined) return;
    this.clearTimers();
    const wallet = this.walletIdentity();
    const wasConnected = this.state.kind === 'connected';
    if (!manager.hasPath(PATH_CHILD.receive)) {
      this.setState({ kind: 'missing_receive', wallet, reconnectingSince: null });
      return;
    }
    const receive = manager.getSessionPaths().find((path) => path.name === 'receive');
    let network: XpubNetwork;
    try {
      if (receive === undefined) throw new Error('wallet_ready lists no receive xpub');
      network = xpubNetwork(receive.xpub);
    } catch (error) {
      this.setState({ kind: 'error', message: describe(error) });
      return;
    }
    if (network !== this.config.xpubNetwork) {
      this.setState({ kind: 'wrong_network', wallet, walletNetwork: network, reconnectingSince: null });
      return;
    }
    const receive0 = manager.getPubkey(PATH_CHILD.receive, 0n);
    if (receive0 === undefined) {
      this.setState({ kind: 'missing_receive', wallet, reconnectingSince: null });
      return;
    }
    let owner: OwnerIdentity;
    try {
      owner = ownerIdentity(receive0, this.config);
    } catch (error) {
      this.setState({ kind: 'error', message: describe(error) });
      return;
    }
    this.setState({ kind: 'connected', wallet, owner, reconnectingSince: null });
    if (!wasConnected) this.emit({ type: 'connected', wallet, owner });
  }

  private handleReconnecting(): void {
    const state = this.state;
    if (state.kind === 'connected' || state.kind === 'wrong_network' || state.kind === 'missing_receive') {
      if (state.reconnectingSince === null) this.setState({ ...state, reconnectingSince: Date.now() });
    }
  }

  private handleAlive(): void {
    if (this.reconnectingSince() === null) return;
    const state = this.state;
    if (state.kind === 'connected' || state.kind === 'wrong_network' || state.kind === 'missing_receive') {
      this.setState({ ...state, reconnectingSince: null });
    }
  }

  private async handleRemoteDisconnect(reason: string, message: string | null): Promise<void> {
    this.manager?.clearStoredSession();
    await this.teardown();
    this.setState({ kind: 'disconnected', byUser: false, reason, message });
    this.emit({ type: 'disconnected', byUser: false, reason, message });
  }

  /** Derives a key of the connected wallet locally (xpubs never leave the browser). */
  pubkeyAt = (pathName: WalletPathName, index: number): Uint8Array | undefined => {
    if (this.state.kind !== 'connected') return undefined;
    return this.manager?.getPubkey(PATH_CHILD[pathName], BigInt(index));
  };

  /**
   * Sends a core draft to the wallet with `broadcast: false` and returns the wallet's signed hex.
   * No time limit (DD 7.8): it waits until the wallet answers, the session ends, or `signal` aborts.
   * The caller passes the result to `finalizeWalletSignedTransaction` (see `lib/wallet/sign.ts`).
   */
  async requestSignature(draft: UnsignedTransactionDraft, signal?: AbortSignal): Promise<string> {
    const manager = this.manager;
    if (manager === undefined || this.state.kind !== 'connected') {
      throw new WalletError('WALLET_NOT_READY', 'No connected wallet can sign this transaction.');
    }
    let response: SignTransactionResponse;
    try {
      response = await manager.signTransaction(
        asLibraryRequest(draft.request),
        signal === undefined ? undefined : { signal },
      );
    } catch (error) {
      if (signal?.aborted) {
        throw new WalletError('SIGN_REQUEST_CANCELLED', 'You cancelled the request. Nothing was sent.', {
          cause: error,
        });
      }
      throw new WalletError('WALLET_SESSION_ENDED', 'The wallet session ended while the request was open.', {
        cause: error,
      });
    }
    if (response.error !== undefined && response.error !== '') {
      throw new WalletError('WALLET_DECLINED', response.error);
    }
    if (response.signedTransaction === '') {
      throw new WalletError('WALLET_DECLINED', 'The wallet returned no signed transaction.');
    }
    return response.signedTransaction;
  }
}

export const wrongNetworkCopy = (walletNetwork: XpubNetwork, config: NetworkConfig): string =>
  `Your wallet is on ${walletNetworkLabel(walletNetwork)}. AtPrice is running on ${config.name}. Switch your wallet to ${config.name}, then connect again.`;
