// @vitest-environment happy-dom
import { encodeLockingBytecodeP2pkh } from '@bitauth/libauth';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecoverConfig } from '../src/config';
import { ServerSession } from '../src/core/server-session';
import { computeFileHash, renderRecoverDocument, sha256Hex } from '../src/shell/document';
import { App } from '../src/ui/app';
import { cancelHeading, signBlocker } from '../src/ui/cancel-section';
import { ConnectBlock, QR_LABEL } from '../src/ui/connect-block';
import { FindSection, SERVER_FIRST, USE_WALLET_REASON } from '../src/ui/find-section';
import { RecoverWallet, type RecoverWalletState } from '../src/wallet/session';
import { FakeChain } from './support/chain';
import { buyParams, OWNER, seedUnspentOrder, STRANGER } from './support/orders';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CONFIG: RecoverConfig = { network: 'chipnet', version: '1.0.0', websiteUrl: null, sourceUrl: null };
const WALLET_ID = { name: 'Paytaca', icon: null };

const renderBlock = (state: RecoverWalletState, wallet = new RecoverWallet(CONFIG)) =>
  render(<ConnectBlock wallet={wallet} state={state} ownerPkh={OWNER.pkh} network="chipnet" />);

describe('file hash in the page', () => {
  it('matches the SHA-256 of the file the build wrote', () => {
    // #given a built file
    const html = renderRecoverDocument({
      title: 'Recover an order · AtPrice',
      csp: "default-src 'none'",
      icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      css: 'body{margin:0}',
      js: 'console.log(1)',
    });
    // #when the page parses it and recomputes #then the hashes agree
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(computeFileHash(parsed)).toBe(sha256Hex(html));
  });
});

describe('ConnectBlock', () => {
  it('starts pairing from idle', () => {
    const wallet = new RecoverWallet(CONFIG);
    const connect = vi.spyOn(wallet, 'connect').mockResolvedValue();
    renderBlock({ kind: 'idle' }, wallet);
    expect(screen.getByRole('heading', { name: 'Connect the owner wallet' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect owner wallet' }));
    expect(connect).toHaveBeenCalledOnce();
  });

  it('shows the pairing code with its label, copy, deep link and cancel', () => {
    const now = Date.now();
    renderBlock({
      kind: 'pairing',
      uri: 'wiz://?p=abc&s=def',
      qrUri: 'WIZ://%3FP%3DABC',
      shownAt: now,
      warningSince: null,
      deadline: now + 300_000,
    });
    expect(screen.getByRole('heading', { name: 'Pair the wallet that created this order' })).toBeTruthy();
    expect(screen.getByRole('img', { name: QR_LABEL })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy pairing link' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open pairing link in your wallet app' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel pairing' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep waiting' })).toBeNull();
  });

  it('offers Keep waiting 30 s before the limit and announces it once', () => {
    const now = Date.now();
    const wallet = new RecoverWallet(CONFIG);
    const keepWaiting = vi.spyOn(wallet, 'keepWaiting').mockReturnValue();
    renderBlock(
      {
        kind: 'pairing',
        uri: 'wiz://?p=a',
        qrUri: 'WIZ://A',
        shownAt: now - 270_000,
        warningSince: now,
        deadline: now + 30_000,
      },
      wallet,
    );
    expect(screen.getByText('This page stops waiting in 0:30.').getAttribute('role')).toBe('status');
    fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(keepWaiting).toHaveBeenCalledOnce();
  });

  it('moves focus to the new status heading on each state change', () => {
    const wallet = new RecoverWallet(CONFIG);
    const { rerender } = renderBlock({ kind: 'idle' }, wallet);
    rerender(
      <ConnectBlock
        wallet={wallet}
        state={{
          kind: 'connected',
          wallet: WALLET_ID,
          owner: { ownerPkh: OWNER.pkh, address: 'bchtest:q' },
          reconnectingSince: null,
        }}
        ownerPkh={OWNER.pkh}
        network="chipnet"
      />,
    );
    expect(document.activeElement?.textContent).toBe('Owner wallet connected');
  });

  it('names a wallet that is not the owner and offers only Disconnect', () => {
    renderBlock({
      kind: 'connected',
      wallet: WALLET_ID,
      owner: { ownerPkh: STRANGER.pkh, address: 'bchtest:q' },
      reconnectingSince: null,
    });
    expect(screen.getByRole('heading', { name: "This wallet isn't the owner" })).toBeTruthy();
    expect(screen.getByText(/Connect the wallet that created it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('explains a wallet on another network', () => {
    renderBlock({
      kind: 'wrong_network',
      wallet: WALLET_ID,
      walletNetwork: 'mainnet',
      reconnectingSince: null,
    });
    expect(
      screen.getByText(
        'Your wallet is on mainnet. This file recovers chipnet orders. Switch your wallet, then connect again.',
      ),
    ).toBeTruthy();
  });

  it('reads a protocol mismatch in plain words and offers Connect again', () => {
    renderBlock({ kind: 'disconnected', reason: 'protocol_mismatch', message: null });
    expect(
      screen.getByText("Your wallet doesn't support the hdwalletv1 protocol AtPrice uses."),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeTruthy();
  });

  it('says when the relay itself is unreachable and points to Other ways', () => {
    renderBlock({ kind: 'error', message: 'ECONNREFUSED', relayUnreachable: true });
    const alert = screen.getByRole('alert');
    expect(
      within(alert).getByText(/Couldn't reach the wallet connection relay \(ECONNREFUSED\)/),
    ).toBeTruthy();
    expect(within(alert).getByRole('link', { name: 'Other ways' }).getAttribute('href')).toBe('#other-ways');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows the reconnecting line with Disconnect', () => {
    renderBlock({
      kind: 'connected',
      wallet: WALLET_ID,
      owner: { ownerPkh: OWNER.pkh, address: 'bchtest:q' },
      reconnectingSince: Date.now(),
    });
    expect(screen.getByRole('heading', { name: 'Reconnecting' })).toBeTruthy();
    expect(screen.getByText(/Requests resume when it answers/)).toBeTruthy();
  });
});

describe('Sign cancel in wallet', () => {
  const connected = {
    kind: 'connected',
    host: 'h',
    endpoint: { host: 'h', port: 1, transport: 'wss' },
    chain: new FakeChain(),
    tip: 1,
    lost: false,
  } as const;
  const ready = { kind: 'invalid', rule: 'x' } as const;
  const base = {
    server: connected,
    wallet: { kind: 'idle' } as RecoverWalletState,
    ownerMatches: false,
    plan: null,
    network: 'chipnet' as const,
    reconnectElapsed: '0:05',
  };

  it('gives the first failing reason in the spec order', () => {
    expect(signBlocker({ ...base, server: { kind: 'idle' } })).toBe('Connect to a server first.');
    expect(signBlocker(base)).toBe('Connect the owner wallet first.');
    const ownerWallet: RecoverWalletState = {
      kind: 'connected',
      wallet: WALLET_ID,
      owner: { ownerPkh: OWNER.pkh, address: 'a' },
      reconnectingSince: 1,
    };
    expect(signBlocker({ ...base, wallet: ownerWallet, ownerMatches: true })).toBe(
      'Reconnecting to your wallet (0:05). Requests resume when it answers.',
    );
    expect(
      signBlocker({ ...base, wallet: { ...ownerWallet, reconnectingSince: null }, ownerMatches: true }),
    ).toBe('Building the cancel.');
    expect(
      signBlocker({
        ...base,
        wallet: { ...ownerWallet, reconnectingSince: null },
        ownerMatches: true,
        plan: ready,
      }),
    ).toBe("The cancel failed a safety check, so it can't be signed.");
  });

  it('heads the cancel block with the state the owner is in', () => {
    const coins = { kind: 'ready', utxos: [], since: 0 } as const;
    expect(
      cancelHeading(
        coins,
        {
          kind: 'no_owner_utxo',
          reason: 'owner_address_empty',
          requiredSatoshis: 546n,
          askSatoshis: 1_500n,
          largestSatoshis: 0n,
        },
        { kind: 'idle' },
        null,
      ),
    ).toBe('The owner wallet needs a coin');
    expect(
      cancelHeading(coins, null, { kind: 'awaiting', since: 0, controller: new AbortController() }, null),
    ).toBe('Approve the cancel in your wallet');
    expect(cancelHeading(coins, null, { kind: 'idle' }, { txid: 'a', height: 0 })).toBe('Cancel sent');
    expect(cancelHeading(coins, null, { kind: 'idle' }, { txid: 'a', height: 5 })).toBe('Cancelled');
  });
});

describe('FindSection', () => {
  it('keeps every control reachable with the reason while no server is connected', () => {
    render(
      <FindSection
        network="chipnet"
        connected={false}
        mode="address"
        value=""
        activity={{ kind: 'idle' }}
        walletAddress={null}
        onModeChange={() => undefined}
        onValueChange={() => undefined}
        onFind={() => undefined}
        headingRef={{ current: null }}
      />,
    );
    const find = screen.getByRole('button', { name: 'Find order' });
    expect(find.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText(SERVER_FIRST).length).toBeGreaterThan(0);
    expect(screen.getByText(USE_WALLET_REASON)).toBeTruthy();
  });
});

describe('App with a fake server', () => {
  it('connects, finds an order by txid, focuses step 3 and builds the cancel', async () => {
    // #given an unspent order and an owner coin on the server
    const chain = new FakeChain();
    const params = buyParams();
    const txid = seedUnspentOrder(chain, params);
    chain.setUtxos(encodeLockingBytecodeP2pkh(OWNER.pkh), [
      { txid: 'cd'.repeat(32), vout: 2, satoshis: 1_000n, height: 342_300 },
    ]);
    const session = new ServerSession('chipnet', () => chain);
    const wallet = new RecoverWallet(CONFIG);
    wallet.start();
    render(
      <App config={CONFIG} session={session} wallet={wallet} fileHash={'ab'.repeat(32)} prefill={null} />,
    );

    // #when the user picks a server and searches
    fireEvent.change(screen.getByLabelText('Bitcoin Cash server'), { target: { value: '0' } });
    await screen.findByText('Connected');
    fireEvent.change(screen.getByRole('textbox', { name: 'Funding transaction id' }), {
      target: { value: txid },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Find order' }));
    });

    // #then the order is shown, focus is on its heading and the cancel is ready to sign once a wallet connects
    await screen.findByText('Unspent: can cancel');
    await waitFor(() => expect(document.activeElement?.id).toBe('step-order'));
    expect(screen.getByText('58.00 PUSDTEST')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Ready to cancel' })).toBeTruthy();
    expect(screen.getByText('A coin at the owner address')).toBeTruthy();
    const sign = screen.getByRole('button', { name: 'Sign cancel in wallet' });
    expect(sign.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Connect the owner wallet first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy unsigned tx' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('shows the no-owner-coin state with the 1,500 sat ask', async () => {
    const chain = new FakeChain();
    const txid = seedUnspentOrder(chain, buyParams());
    const session = new ServerSession('chipnet', () => chain);
    const wallet = new RecoverWallet(CONFIG);
    wallet.start();
    render(<App config={CONFIG} session={session} wallet={wallet} fileHash={null} prefill={null} />);
    fireEvent.change(screen.getByLabelText('Bitcoin Cash server'), { target: { value: '0' } });
    await screen.findByText('Connected');
    fireEvent.change(screen.getByRole('textbox', { name: 'Funding transaction id' }), {
      target: { value: txid },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Find order' }));
    });
    expect(await screen.findByRole('heading', { name: 'The owner wallet needs a coin' })).toBeTruthy();
    expect(screen.getByText(/0\.00001500 BCH \(1,500 sat\)/)).toBeTruthy();
    expect(screen.getByText('Show QR')).toBeTruthy();
    // #when the top-up lands #then the cancel is rebuilt
    act(() =>
      chain.setUtxos(encodeLockingBytecodeP2pkh(OWNER.pkh), [
        { txid: 'ef'.repeat(32), vout: 0, satoshis: 1_500n, height: 0 },
      ]),
    );
    expect(await screen.findByRole('heading', { name: 'Ready to cancel' })).toBeTruthy();
  });

  it('shows the empty state for a transaction without a record', async () => {
    const chain = new FakeChain();
    chain.addTransaction(
      'ab'.repeat(32),
      '0200000001' + 'ab'.repeat(32) + '000000000000000000' + '01' + '0000000000000000' + '00' + '00000000',
    );
    const session = new ServerSession('chipnet', () => chain);
    const wallet = new RecoverWallet(CONFIG);
    render(<App config={CONFIG} session={session} wallet={wallet} fileHash={null} prefill={null} />);
    fireEvent.change(screen.getByLabelText('Bitcoin Cash server'), { target: { value: '0' } });
    await screen.findByText('Connected');
    fireEvent.change(screen.getByRole('textbox', { name: 'Funding transaction id' }), {
      target: { value: 'ab'.repeat(32) },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Find order' }));
    });
    expect(await screen.findByText(/This transaction has no AtPrice order record/)).toBeTruthy();
  });
});
