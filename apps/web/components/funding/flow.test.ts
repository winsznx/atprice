import type { FundingDraft, SignedTransaction, WalletUtxo } from '@atprice/core';
import { describe, expect, it } from 'vitest';
import type { Registration } from '@/lib/api/schemas';
import { BROADCAST_TIMEOUT_MS } from '@/lib/wallet/constants';
import { WalletError } from '@/lib/wallet/errors';
import type { BroadcastOutcome } from '@/lib/wallet/sign';
import type { FundingPreview } from './fees';
import {
  closeBlockedReason,
  FundingFlow,
  phaseTxid,
  REGISTER_RETRY_MS,
  type FundingDeps,
  type FundingEvent,
} from './flow';

const ORDER_LOCKING = Uint8Array.of(0xaa, 0x20, 1, 2, 3);
const TXID = 'ab'.repeat(32);

const utxo = (vout: number): WalletUtxo => ({
  txid: 'cd'.repeat(32),
  vout,
  satoshis: 100_000_000n,
  lockingBytecode: `76a914${'11'.repeat(20)}88ac`,
  pathName: 'receive',
  addressIndex: 0,
});

const draft = (fee: bigint, owner = 49_000_000n, locking = ORDER_LOCKING): FundingDraft =>
  ({
    fee,
    ownerOutputSatoshis: owner,
    orderLockingBytecode: locking,
  }) as unknown as FundingDraft;

const signed: SignedTransaction = { hex: '00', txid: TXID, size: 300, fee: 300n, sourceOutputs: [] };

const registration: Registration = {
  orderId: `${TXID}:0`,
  status: 'FUNDING_PENDING',
  supported: true,
  unsupportedReason: null,
};

interface Harness {
  readonly flow: FundingFlow;
  readonly events: FundingEvent[];
  readonly timers: { run: () => void; ms: number; cleared: boolean }[];
  scans: (readonly WalletUtxo[])[];
  preview: FundingPreview;
  signResult: () => Promise<SignedTransaction>;
  broadcastResult: () => Promise<BroadcastOutcome>;
  registerResult: () => Promise<Registration>;
  seenResult: boolean;
  scanFails: boolean;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const harness = (): Harness => {
  const h = {
    events: [] as FundingEvent[],
    timers: [] as { run: () => void; ms: number; cleared: boolean }[],
    scans: [[utxo(0)]] as (readonly WalletUtxo[])[],
    preview: { kind: 'ok', draft: draft(300n) } as FundingPreview,
    signResult: () => Promise.resolve(signed),
    broadcastResult: (): Promise<BroadcastOutcome> => Promise.resolve({ kind: 'accepted', txid: TXID }),
    registerResult: () => Promise.resolve(registration),
    seenResult: false,
    scanFails: false,
  } as Omit<Harness, 'flow'>;
  const deps: FundingDeps = {
    scanUtxos: () =>
      h.scanFails
        ? Promise.reject(new Error('socket closed'))
        : Promise.resolve(h.scans.length > 1 ? (h.scans.shift() ?? []) : (h.scans[0] ?? [])),
    scanErrorCode: () => 'ELECTRUM_UNREACHABLE',
    build: () => h.preview,
    expectedOrderLocking: ORDER_LOCKING,
    sign: () => h.signResult(),
    broadcast: () => h.broadcastResult(),
    seen: () => Promise.resolve(h.seenResult),
    register: () => h.registerResult(),
    registerErrorCode: () => 'funding_not_observed',
    endpointLabel: () => 'electrum.example:50004',
    onEvent: (event) => h.events.push(event),
    now: () => 1_000,
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      h.timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
  };
  return Object.assign(h, { flow: new FundingFlow(deps) });
};

describe('FundingFlow', () => {
  it('builds into review', async () => {
    const h = harness();
    await h.flow.build();
    expect(h.flow.getPhase().kind).toBe('review');
  });

  it('shows a UTXO read failure by name', async () => {
    const h = harness();
    h.scanFails = true;
    await h.flow.build();
    expect(h.flow.getPhase()).toEqual({
      kind: 'utxo_error',
      code: 'ELECTRUM_UNREACHABLE',
      host: 'electrum.example:50004',
    });
  });

  it('keeps the balance shortfall in review with confirm blocked', async () => {
    const h = harness();
    h.preview = { kind: 'short', resource: 'bch', required: 60_000_000n, available: 50_000_000n };
    await h.flow.build();
    const phase = h.flow.getPhase();
    expect(phase.kind === 'review' ? phase.shortfall : null).toEqual({
      needed: 60_000_000n,
      available: 50_000_000n,
    });
  });

  it('refuses a draft that pays a different contract (DRAFT_CHANGED)', async () => {
    const h = harness();
    h.preview = { kind: 'ok', draft: draft(300n, 49_000_000n, Uint8Array.of(1)) };
    await h.flow.build();
    expect(h.flow.getPhase().kind).toBe('draft_changed');
  });

  it('rebuilds and stops for a second look when coins changed before signing', async () => {
    const h = harness();
    h.scans = [[utxo(0)], [utxo(0), utxo(1)]];
    await h.flow.build();
    h.preview = { kind: 'ok', draft: draft(450n, 48_000_000n) };
    await h.flow.confirm();
    const phase = h.flow.getPhase();
    expect(phase.kind === 'review' ? [phase.coinsChanged, phase.updated] : null).toEqual([
      true,
      ['kept', 'funding_fee', 'leaves'],
    ]);
  });

  it('a decline returns to the draft with nothing created', async () => {
    const h = harness();
    h.signResult = () => Promise.reject(new WalletError('WALLET_DECLINED', 'User rejected'));
    await h.flow.build();
    await h.flow.confirm();
    await settle();
    expect([h.flow.getPhase().kind, h.events.map((event) => event.type)]).toEqual([
      'rejected',
      ['review_ready', 'awaiting_signature', 'declined'],
    ]);
  });

  it('a session that ends while waiting is a named signing error', async () => {
    const h = harness();
    h.signResult = () => Promise.reject(new WalletError('WALLET_SESSION_ENDED', 'session ended'));
    await h.flow.build();
    await h.flow.confirm();
    await settle();
    const phase = h.flow.getPhase();
    expect(phase.kind === 'signing_error' ? phase.code : phase.kind).toBe('WALLET_SESSION_ENDED');
  });

  it('a changed signed transaction is never broadcast', async () => {
    const h = harness();
    let broadcasts = 0;
    h.signResult = () => Promise.reject(new WalletError('SIGNED_TX_MISMATCH', 'output 2 changed'));
    h.broadcastResult = () => {
      broadcasts += 1;
      return Promise.resolve({ kind: 'accepted', txid: TXID });
    };
    await h.flow.build();
    await h.flow.confirm();
    await settle();
    expect([h.flow.getPhase().kind, broadcasts]).toEqual(['signed_changed', 0]);
  });

  it('Cancel request stops waiting and ignores a later answer', async () => {
    const h = harness();
    let answer: (value: SignedTransaction) => void = () => undefined;
    h.signResult = () => new Promise((resolve) => (answer = resolve));
    await h.flow.build();
    await h.flow.confirm();
    h.flow.cancelRequest();
    answer(signed);
    await settle();
    const phase = h.flow.getPhase();
    expect(phase.kind === 'review' ? phase.stoppedWaiting : phase.kind).toBe(true);
  });

  it('waits for the wallet with no time limit', async () => {
    const h = harness();
    h.signResult = () => new Promise(() => undefined);
    await h.flow.build();
    await h.flow.confirm();
    expect([h.flow.getPhase().kind, h.timers.length]).toEqual(['awaiting_signature', 0]);
  });

  it('signs, broadcasts and registers', async () => {
    const h = harness();
    await h.flow.build();
    await h.flow.confirm();
    await settle();
    expect([h.flow.getPhase().kind, h.events.map((event) => event.type)]).toEqual([
      'registered',
      ['review_ready', 'awaiting_signature', 'signed', 'funding_sent', 'registered'],
    ]);
  });

  it('a rejected broadcast says nothing was spent', async () => {
    const h = harness();
    h.broadcastResult = () => Promise.resolve({ kind: 'rejected', detail: 'missing inputs' });
    await h.flow.build();
    await h.flow.confirm();
    await settle();
    expect(h.flow.getPhase()).toEqual({ kind: 'broadcast_rejected', message: 'missing inputs' });
  });

  it('moves to broadcast unknown after 20 s without an answer, and Check again finds it', async () => {
    const h = harness();
    h.broadcastResult = () => new Promise(() => undefined);
    await h.flow.build();
    await h.flow.confirm();
    await settle();
    const timer = h.timers.find((entry) => entry.ms === BROADCAST_TIMEOUT_MS);
    timer?.run();
    const unknown = h.flow.getPhase().kind;
    h.seenResult = true;
    await h.flow.checkAgain();
    await settle();
    expect([unknown, h.flow.getPhase().kind]).toEqual(['broadcast_unknown', 'registered']);
  });

  it('offers Broadcast again only after Check again found nothing', async () => {
    const h = harness();
    h.broadcastResult = () => Promise.resolve({ kind: 'unknown', txid: TXID, detail: 'connection closed' });
    await h.flow.build();
    await h.flow.confirm();
    await settle();
    await h.flow.checkAgain();
    const phase = h.flow.getPhase();
    expect(phase.kind === 'broadcast_unknown' ? phase.check : phase.kind).toBe('not_found');
  });

  it('keeps retrying registration every 15 s and says the order is funded', async () => {
    const h = harness();
    h.registerResult = () => Promise.reject(new Error('404'));
    await h.flow.build();
    await h.flow.confirm();
    await settle();
    const failed = h.flow.getPhase().kind;
    h.registerResult = () => Promise.resolve(registration);
    h.timers.find((entry) => entry.ms === REGISTER_RETRY_MS)?.run();
    await settle();
    expect([
      failed,
      h.flow.getPhase().kind,
      h.events.filter((e) => e.type === 'register_failed').length,
    ]).toEqual(['register_failed', 'registered', 1]);
  });
});

describe('phase helpers', () => {
  it('shows the txid from broadcasting on', () => {
    expect(phaseTxid({ kind: 'broadcasting', signed, since: 0, host: null })).toBe(TXID);
  });

  it('blocks close while the wallet is asked', () => {
    expect(closeBlockedReason({ kind: 'awaiting_signature', draft: draft(1n), since: 0 }, '0:03')).toBe(
      'Wait until your wallet answers or cancel the request.',
    );
  });
});
