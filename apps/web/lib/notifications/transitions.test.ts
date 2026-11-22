import { describe, expect, it } from 'vitest';
import type { Order } from '../api/schemas';
import { messagesForStatusChange } from './transitions';

const TXID = 'a'.repeat(64);

const order = (status: Order['status'], overrides: Partial<Order> = {}): Order => ({
  id: `${TXID}:0`,
  funding: { txid: TXID, vout: 0 },
  tokenCategory: 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
  side: 'buy',
  amount: 50_000_000n,
  minOut: 23_000n,
  maxNetworkFee: 2_000n,
  ownerPkh: '00'.repeat(20),
  recipientAddress: 'bchtest:qexample',
  contractVersion: 1,
  contractAddress: 'bchtest:pexample',
  status,
  supported: true,
  unsupportedReason: null,
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:00:00.000Z',
  events: [
    {
      txid: TXID,
      kind: 'funding',
      firstSeenAt: '2026-11-22T10:00:00.000Z',
      confirmations: 1,
      blockHeight: 925_114,
      blockHash: 'b'.repeat(64),
      networkState: 'confirmed',
      conflict: null,
    },
  ],
  keeperCheck: null,
  settlement: null,
  ...overrides,
});

const refs = (previous: Order['status'] | undefined, next: Order, cancelSentHere = false) =>
  messagesForStatusChange(previous, next, { cancelSentHere }).map((message) => message.ref);

describe('polled status changes (notifications.md)', () => {
  it('raises 5+6 when funding confirms and the order opens in one poll', () => {
    const [message] = messagesForStatusChange('FUNDING_PENDING', order('OPEN'), { cancelSentHere: false });
    expect(message?.ref).toBe('5+6');
    expect(message?.meta).toBe('Confirmed in block 925,114');
  });

  it('raises nothing for an unchanged status or for a cancel the dialog owns', () => {
    expect(refs('OPEN', order('OPEN'))).toEqual([]);
    expect(refs('OPEN', order('CANCELLATION_PENDING'))).toEqual([]);
  });

  it('keeps attempt and fact apart: fill sent, then order filled', () => {
    const sent = messagesForStatusChange('OPEN', order('EXECUTION_PENDING'), { cancelSentHere: false })[0];
    expect(sent?.ref).toBe('7');
    expect(sent?.meta).toBe('Not confirmed yet');
    expect(refs('EXECUTION_PENDING', order('FILLED'))).toEqual(['8']);
  });

  it('reports a lost race (11c) only when this browser sent the cancel', () => {
    expect(refs('CANCELLATION_PENDING', order('FILLED'), true)).toEqual(['11c']);
    expect(refs('CANCELLATION_PENDING', order('FILLED'), false)).toEqual(['8']);
  });

  it('reports a reorged-out confirmation (14) apart from other reviews (13)', () => {
    expect(refs('FILLED', order('RECONCILIATION_REQUIRED'))).toEqual(['14']);
    expect(refs('OPEN', order('RECONCILIATION_REQUIRED'))).toEqual(['13']);
  });

  it('never uses confirmed wording on an attempt', () => {
    for (const message of messagesForStatusChange('OPEN', order('EXECUTION_PENDING'), {
      cancelSentHere: false,
    })) {
      expect(`${message.title} ${message.body}`).not.toMatch(/confirmed|complete|done/i);
    }
  });
});
