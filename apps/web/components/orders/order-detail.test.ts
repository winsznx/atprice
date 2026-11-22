import { describe, expect, it } from 'vitest';
import type { Health } from '@/lib/api/schemas';
import type { NetworkCheck } from '@/lib/hooks/use-network-check';
import type { WalletState } from '@/lib/wallet/connector';
import {
  breadcrumbFor,
  cancelAvailability,
  conditionText,
  executionCondition,
  keeperStale,
  orderRefreshInterval,
  outcomeWords,
  ownershipOf,
  raceLost,
  unexpectedSpend,
} from './order-detail';
import { isOrderId, openGraphDescription, openGraphTitle, titleBlock } from './order-title';
import { event, FUNDING_TXID, makeOrder, makeSellOrder, OWNER_PKH, SETTLEMENT_TXID } from './test-fixtures';

const MATCH: NetworkCheck = { status: 'match' };

const connected = (ownerPkhHex: string, reconnectingSince: number | null = null): WalletState =>
  ({
    kind: 'connected',
    wallet: { name: 'Paytaca', icon: null },
    owner: {
      publicKey: new Uint8Array(33),
      ownerPkh: new Uint8Array(20),
      ownerPkhHex,
      address: 'bchtest:qq',
      tokenAddress: 'bchtest:zq',
    },
    reconnectingSince,
  }) satisfies WalletState;

const fill = {
  kind: 'fill' as const,
  txid: SETTLEMENT_TXID,
  blockHeight: 925_118,
  confirmations: 3,
  received: 23_062n,
  surplus: 62n,
  poolOutpoint: { txid: 'ee'.repeat(32), vout: 0 },
  poolPkh: 'cd'.repeat(20),
  poolFeeSats: 150_000n,
  networkFeeSats: 783n,
  filledBy: 'other' as const,
};

describe('order-detail.md route and title block', () => {
  it('accepts only a 64-hex funding txid as the id', () => {
    expect(isOrderId(FUNDING_TXID)).toBe(true);
    expect(isOrderId(`${FUNDING_TXID}:0`)).toBe(false);
    expect(isOrderId(FUNDING_TXID.toUpperCase())).toBe(false);
  });

  it('keeps the <h1> to words and puts the figure, with units, under it', () => {
    expect(titleBlock(makeOrder())).toEqual({ heading: 'Buy PUSDTEST', figure: 'Limit 460.00 PUSDTEST per BCH' });
    expect(titleBlock(makeOrder({ status: 'FILLED', settlement: fill }))).toEqual({
      heading: 'Bought PUSDTEST',
      figure: '230.62 PUSDTEST for 0.50 BCH',
    });
    expect(
      titleBlock(makeSellOrder({ status: 'FILLED', settlement: { ...fill, received: 5_312_000n } })),
    ).toEqual({ heading: 'Sold PUSDTEST', figure: '0.0531 BCH for 1,250.00 PUSDTEST' });
    expect(
      titleBlock(
        makeOrder({
          status: 'CANCELLED',
          settlement: {
            kind: 'cancel',
            txid: SETTLEMENT_TXID,
            blockHeight: 1,
            confirmations: 1,
            refundSats: 50_002_600n,
            refundTokens: 0n,
            networkFeeSats: 400n,
            refundAddress: 'bchtest:qq',
            authorizedBy: 'cancel',
          },
        }),
      ),
    ).toEqual({ heading: 'Cancelled order', figure: '0.500026 BCH refunded' });
  });

  it('writes link previews without any address', () => {
    const order = makeOrder();
    expect(openGraphTitle(order)).toBe('Buy PUSDTEST at 460.00 PUSDTEST per BCH on AtPrice');
    expect(openGraphDescription(order, 'Open')).toBe('Status: Open. Funded 22 Nov 2026.');
  });
});

describe('owner and cancel rules', () => {
  it('derives ownership from the receive/0 key hash', () => {
    expect(ownershipOf(connected(OWNER_PKH), OWNER_PKH).kind).toBe('owner');
    expect(ownershipOf(connected('00'.repeat(20)), OWNER_PKH).kind).toBe('not_owner');
    expect(ownershipOf({ kind: 'idle' }, OWNER_PKH).kind).toBe('disconnected');
    expect(ownershipOf({ kind: 'loading' }, OWNER_PKH).kind).toBe('unknown');
    expect(
      ownershipOf({ kind: 'missing_receive', wallet: { name: 'x', icon: null }, reconnectingSince: null }, OWNER_PKH)
        .kind,
    ).toBe('missing_receive');
  });

  it('offers cancel to the owner of an OPEN or FUNDING_PENDING order only', () => {
    const owner = ownershipOf(connected(OWNER_PKH), OWNER_PKH);
    expect(cancelAvailability({ status: 'OPEN' }, owner, MATCH)).toEqual({ kind: 'enabled' });
    expect(cancelAvailability({ status: 'FUNDING_PENDING' }, owner, MATCH)).toEqual({ kind: 'enabled' });
    expect(cancelAvailability({ status: 'FILLED' }, owner, MATCH)).toEqual({ kind: 'hidden' });
    expect(cancelAvailability({ status: 'OPEN' }, { kind: 'not_owner' }, MATCH)).toEqual({ kind: 'hidden' });
  });

  it('disables cancel with the spec reason for each blocking state', () => {
    const owner = ownershipOf(connected(OWNER_PKH), OWNER_PKH);
    const reason = (status: Parameters<typeof cancelAvailability>[0]['status']) => {
      const result = cancelAvailability({ status }, owner, MATCH);
      return result.kind === 'disabled' ? result.reason : null;
    };
    expect(reason('EXECUTION_PENDING')).toBe(
      'A fill for this order is already waiting for confirmation. A cancel can’t replace it.',
    );
    expect(reason('CANCELLATION_PENDING')).toBe('A cancel is already waiting for confirmation.');
    expect(reason('RECONCILIATION_REQUIRED')).toBe(
      'AtPrice can’t confirm this order’s state. Use Recover, which reads the chain directly.',
    );
  });

  it('disables cancel on a network mismatch and while the wallet reconnects', () => {
    const owner = ownershipOf(connected(OWNER_PKH), OWNER_PKH);
    const mismatch = cancelAvailability(
      { status: 'OPEN' },
      owner,
      { status: 'mismatch', web: 'chipnet', api: 'mainnet', reason: 'network' },
    );
    expect(mismatch.kind === 'disabled' && mismatch.reason).toContain('this page is on chipnet but the server is on mainnet');
    const reconnecting = cancelAvailability({ status: 'OPEN' }, ownershipOf(connected(OWNER_PKH, 1), OWNER_PKH), MATCH);
    expect(reconnecting).toEqual({ kind: 'disabled', reason: 'reconnecting', reconnecting: true });
  });
});

describe('execution condition and keeper freshness', () => {
  const spot450 = { numerator: 100_000_000n, denominator: 45_000n };

  it('says not checked before any keeper check', () => {
    expect(conditionText(executionCondition(makeOrder({ keeperCheck: null }), spot450))).toBe(
      'Not checked yet. AtPrice’s keeper checks open orders after their funding confirms.',
    );
  });

  it('says met when the best quote for the whole order reaches minOut', () => {
    const order = makeOrder({
      keeperCheck: { checkedAt: '2026-11-22T14:03:10.000Z', poolOutpoint: null, bestOutput: 23_000n, outcome: 'x' },
    });
    expect(executionCondition(order, spot450).kind).toBe('met');
  });

  it('gives the shortfall from the spot rate when not met', () => {
    expect(conditionText(executionCondition(makeOrder(), spot450))).toBe(
      'Not met yet. The rate now is 2.22% short of your limit.',
    );
  });

  it('warns only when the last check is older than two sweep intervals', () => {
    const health: Health = {
      status: 'ok',
      checkedAt: '2026-11-22T14:05:00.000Z',
      reasons: [],
      sweepIntervalMs: 30_000,
      lastSweepFinishedAt: null,
    };
    const check = makeOrder().keeperCheck;
    const checkedAt = Date.parse('2026-11-22T14:03:10.000Z');
    expect(keeperStale(check, health, checkedAt + 60_000)).toBe(false);
    expect(keeperStale(check, health, checkedAt + 60_001)).toBe(true);
    expect(keeperStale(check, undefined, checkedAt + 600_000)).toBe(false);
  });

  it('maps keeper outcome codes to words and prints unknown codes as sent', () => {
    expect(outcomeWords('NO_POOL')).toEqual({ text: 'No pool can take this size', known: true });
    expect(outcomeWords('SOMETHING_NEW')).toEqual({ text: 'SOMETHING_NEW', known: false });
  });
});

describe('refresh, review and race', () => {
  it('polls by state and stops terminal orders after 6 confirmations', () => {
    expect(orderRefreshInterval(makeOrder({ status: 'EXECUTION_PENDING' }))).toBe(5_000);
    expect(orderRefreshInterval(makeOrder())).toBe(15_000);
    expect(orderRefreshInterval(makeOrder({ status: 'FILLED', settlement: { ...fill, confirmations: 5 } }))).toBe(15_000);
    expect(orderRefreshInterval(makeOrder({ status: 'FILLED', settlement: { ...fill, confirmations: 6 } }))).toBe(false);
  });

  it('names the unexpected spend for the reconciliation alert', () => {
    const order = makeOrder({
      status: 'RECONCILIATION_REQUIRED',
      events: [event(), event({ txid: SETTLEMENT_TXID, kind: 'unknown_spend', conflict: null })],
    });
    expect(unexpectedSpend(order)).toEqual({
      txid: SETTLEMENT_TXID,
      reason: 'the order output was spent by a transaction that is neither a fill nor a cancel',
    });
  });

  it('detects a cancel that lost to a fill', () => {
    const order = makeOrder({
      status: 'FILLED',
      events: [event(), event({ txid: SETTLEMENT_TXID, kind: 'cancel', networkState: 'conflicted' })],
    });
    expect(raceLost(order)).toBe(true);
    expect(raceLost(makeOrder({ status: 'FILLED' }))).toBe(false);
  });

  it('sends the owner back to My orders and everyone else to the market', () => {
    const order = makeOrder();
    expect(breadcrumbFor({ kind: 'owner', reconnectingSince: null }, order, 'bch-pusdtest')).toEqual({
      href: '/orders',
      label: 'My orders',
    });
    expect(breadcrumbFor({ kind: 'disconnected' }, order, 'bch-pusdtest')).toEqual({
      href: '/markets/bch-pusdtest',
      label: 'BCH/PUSDTEST',
    });
  });
});
