import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '@atprice/core';
import { createAnalytics, transitionEvents } from '../../src/analytics.js';

describe('analytics events (PRD 20.1)', () => {
  it('maps observed status edges to the events they stand for', () => {
    expect(transitionEvents(null, 'FUNDING_PENDING')).toEqual(['funding_broadcast']);
    expect(transitionEvents('FUNDING_PENDING', 'OPEN')).toEqual(['funding_confirmed', 'order_opened']);
    expect(transitionEvents(null, 'OPEN')).toEqual(['funding_confirmed', 'order_opened']);
    expect(transitionEvents('EXECUTION_PENDING', 'OPEN')).toEqual([]);
    expect(transitionEvents('OPEN', 'EXECUTION_PENDING')).toEqual(['execution_broadcast']);
    expect(transitionEvents('EXECUTION_PENDING', 'FILLED')).toEqual(['execution_confirmed']);
    expect(transitionEvents('CANCELLATION_PENDING', 'CANCELLED')).toEqual(['cancellation_confirmed']);
    expect(transitionEvents('OPEN', 'RECONCILIATION_REQUIRED')).toEqual([]);
    for (const status of ORDER_STATUSES) expect(Array.isArray(transitionEvents(null, status))).toBe(true);
  });

  it('logs each event with the deployment cohort and network', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    createAnalytics(pino(sink), 'chipnet', 'pilot').emit('order_created', { intentId: 'abc', side: 'buy' });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      analytics: 'order_created',
      cohort: 'pilot',
      network: 'chipnet',
      intentId: 'abc',
      side: 'buy',
    });
  });
});
