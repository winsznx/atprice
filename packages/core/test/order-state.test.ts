import { describe, expect, it } from 'vitest';
import {
  decideTransition,
  deriveOrderState,
  NON_TERMINAL_STATUSES,
  ORDER_STATUS_EDGES,
  ORDER_STATUS_PAIRS,
  ORDER_STATUSES,
  statusAfter,
  type ObservationCause,
  type OrderStatus,
  type TransitionTarget,
} from '../src/index.js';

const ALL_CAUSES: readonly ObservationCause[] = [
  'funding_seen',
  'funding_confirmed',
  'spend_seen',
  'spend_confirmed',
  'spend_vanished',
  'funding_vanished',
  'backfill',
  'unknown_spend',
  'reorg',
  'server_disagreement',
  'resync',
];

/** The architecture r5 table written out independently, one tuple per (from, to, cause). */
const SPEC_TABLE: readonly (readonly [OrderStatus | null, TransitionTarget, ObservationCause])[] = [
  [null, 'FUNDING_PENDING', 'funding_seen'],
  ...(['OPEN', 'FILLED', 'CANCELLED'] as const).flatMap((to) =>
    (['backfill', 'funding_confirmed', 'spend_confirmed'] as const).map(
      (cause) => [null, to, cause] as const,
    ),
  ),
  ...(['EXECUTION_PENDING', 'CANCELLATION_PENDING'] as const).flatMap((to) =>
    (['backfill', 'spend_seen'] as const).map((cause) => [null, to, cause] as const),
  ),
  ['FUNDING_PENDING', 'OPEN', 'funding_confirmed'],
  ['FUNDING_PENDING', 'DELETED', 'funding_vanished'],
  ['OPEN', 'EXECUTION_PENDING', 'spend_seen'],
  ['OPEN', 'CANCELLATION_PENDING', 'spend_seen'],
  ['FUNDING_PENDING', 'CANCELLATION_PENDING', 'spend_seen'],
  ['FUNDING_PENDING', 'EXECUTION_PENDING', 'spend_seen'],
  ['OPEN', 'FILLED', 'spend_confirmed'],
  ['OPEN', 'CANCELLED', 'spend_confirmed'],
  ['FUNDING_PENDING', 'FILLED', 'spend_confirmed'],
  ['FUNDING_PENDING', 'CANCELLED', 'spend_confirmed'],
  ['EXECUTION_PENDING', 'FILLED', 'spend_confirmed'],
  ['CANCELLATION_PENDING', 'CANCELLED', 'spend_confirmed'],
  ['EXECUTION_PENDING', 'CANCELLATION_PENDING', 'spend_seen'],
  ['CANCELLATION_PENDING', 'EXECUTION_PENDING', 'spend_seen'],
  ['EXECUTION_PENDING', 'OPEN', 'spend_vanished'],
  ['CANCELLATION_PENDING', 'OPEN', 'spend_vanished'],
  ...(['FUNDING_PENDING', 'OPEN', 'EXECUTION_PENDING', 'CANCELLATION_PENDING'] as const).flatMap((from) =>
    (['unknown_spend', 'reorg', 'server_disagreement'] as const).map(
      (cause) => [from, 'RECONCILIATION_REQUIRED', cause] as const,
    ),
  ),
  ['FILLED', 'RECONCILIATION_REQUIRED', 'reorg'],
  ['CANCELLED', 'RECONCILIATION_REQUIRED', 'reorg'],
  ...(['OPEN', 'EXECUTION_PENDING', 'CANCELLATION_PENDING', 'FILLED', 'CANCELLED'] as const).map(
    (to) => ['RECONCILIATION_REQUIRED', to, 'resync'] as const,
  ),
];

const key = (from: OrderStatus | null, to: TransitionTarget, cause: ObservationCause): string =>
  `${from ?? '(none)'} -> ${to} [${cause}]`;
const specKeys = new Set(SPEC_TABLE.map(([from, to, cause]) => key(from, to, cause)));

describe('order state transition table', () => {
  it('holds exactly the architecture r5 rows', () => {
    const tableKeys = new Set(
      ORDER_STATUS_EDGES.flatMap((edge) => edge.causes.map((cause) => key(edge.from, edge.to, cause))),
    );
    expect([...tableKeys].sort()).toEqual([...specKeys].sort());
  });

  it.each(SPEC_TABLE.map(([from, to, cause]) => [key(from, to, cause), from, to, cause] as const))(
    'allows %s',
    (_label, from, to, cause) => {
      const decision = decideTransition(from, { derived: to, cause });
      if (to === 'DELETED') {
        expect(decision).toEqual({ kind: 'delete', from });
      } else {
        expect(decision).toEqual({ kind: 'transition', from, to });
        expect(statusAfter(decision)).toBe(to);
      }
    },
  );

  const sources: readonly (OrderStatus | null)[] = [null, ...ORDER_STATUSES];
  const targets: readonly TransitionTarget[] = [...ORDER_STATUSES, 'DELETED'];

  it('reconciles every different-state observation that has no edge, recording the rejected observation', () => {
    let checked = 0;
    for (const from of sources) {
      for (const to of targets) {
        if (to === from) continue;
        for (const cause of ALL_CAUSES) {
          if (specKeys.has(key(from, to, cause))) continue;
          const decision = decideTransition(from, { derived: to, cause });
          checked += 1;
          if (from === null && to === 'DELETED') {
            expect(decision).toEqual({ kind: 'noop', status: null });
          } else if (from === 'RECONCILIATION_REQUIRED') {
            expect(decision).toEqual({ kind: 'noop', status: 'RECONCILIATION_REQUIRED' });
          } else {
            expect(decision).toEqual({
              kind: 'reconcile',
              from,
              to: 'RECONCILIATION_REQUIRED',
              rejected: { derived: to, cause },
            });
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  it('treats an observation deriving the current state as a no-op for every state and cause', () => {
    for (const status of ORDER_STATUSES) {
      for (const cause of ALL_CAUSES) {
        expect(decideTransition(status, { derived: status, cause })).toEqual({ kind: 'noop', status });
      }
    }
  });

  it('keeps a pending order pending when its funding block arrives after the spend (no-op case 1)', () => {
    const facts = { funding: 'confirmed', spend: { kind: 'cancel', confirmed: false } } as const;
    expect(deriveOrderState(facts)).toBe('CANCELLATION_PENDING');
    expect(
      decideTransition('CANCELLATION_PENDING', {
        derived: deriveOrderState(facts),
        cause: 'funding_confirmed',
      }),
    ).toEqual({
      kind: 'noop',
      status: 'CANCELLATION_PENDING',
    });
  });

  it('ignores a repeated notification or reconnect backfill of the same state (no-op case 2)', () => {
    expect(decideTransition('OPEN', { derived: 'OPEN', cause: 'backfill' })).toEqual({
      kind: 'noop',
      status: 'OPEN',
    });
    expect(decideTransition('FILLED', { derived: 'FILLED', cause: 'spend_confirmed' })).toEqual({
      kind: 'noop',
      status: 'FILLED',
    });
  });

  it('walks the chipnet cancel-before-confirmation path FUNDING_PENDING -> CANCELLATION_PENDING -> CANCELLED', () => {
    const first = decideTransition(null, { derived: 'FUNDING_PENDING', cause: 'funding_seen' });
    const second = decideTransition(statusAfter(first), {
      derived: 'CANCELLATION_PENDING',
      cause: 'spend_seen',
    });
    const third = decideTransition(statusAfter(second), { derived: 'CANCELLED', cause: 'spend_confirmed' });
    expect([statusAfter(first), statusAfter(second), statusAfter(third)]).toEqual([
      'FUNDING_PENDING',
      'CANCELLATION_PENDING',
      'CANCELLED',
    ]);
  });

  it('never moves a terminal order silently back: a reorg goes to RECONCILIATION_REQUIRED', () => {
    expect(decideTransition('FILLED', { derived: 'OPEN', cause: 'spend_vanished' }).kind).toBe('reconcile');
    expect(decideTransition('FILLED', { derived: 'RECONCILIATION_REQUIRED', cause: 'reorg' })).toEqual({
      kind: 'transition',
      from: 'FILLED',
      to: 'RECONCILIATION_REQUIRED',
    });
  });

  it('does not reopen a pending order whose funding is unconfirmed (no edge to FUNDING_PENDING)', () => {
    expect(
      decideTransition('EXECUTION_PENDING', { derived: 'FUNDING_PENDING', cause: 'spend_vanished' }).kind,
    ).toBe('reconcile');
  });

  it('lists every status pair the trigger must allow, and only those', () => {
    const pairs = new Set(ORDER_STATUS_PAIRS.map(([from, to]) => `${from ?? '-'}>${to}`));
    for (const [from, to] of SPEC_TABLE) expect(pairs.has(`${from ?? '-'}>${to}`)).toBe(true);
    for (const from of [...NON_TERMINAL_STATUSES, 'FILLED', 'CANCELLED'] as const) {
      if (from === 'RECONCILIATION_REQUIRED') continue;
      expect(pairs.has(`${from}>RECONCILIATION_REQUIRED`)).toBe(true);
    }
    expect(pairs.has('->RECONCILIATION_REQUIRED')).toBe(true);
    expect(pairs.has('FILLED>OPEN')).toBe(false);
    expect(pairs.has('OPEN>FUNDING_PENDING')).toBe(false);
  });
});

describe('deriveOrderState', () => {
  it.each([
    [{ funding: 'mempool', spend: { kind: 'none' } }, 'FUNDING_PENDING'],
    [{ funding: 'confirmed', spend: { kind: 'none' } }, 'OPEN'],
    [{ funding: 'missing', spend: { kind: 'none' } }, 'DELETED'],
    [{ funding: 'mempool', spend: { kind: 'execute', confirmed: false } }, 'EXECUTION_PENDING'],
    [{ funding: 'confirmed', spend: { kind: 'execute', confirmed: true } }, 'FILLED'],
    [{ funding: 'confirmed', spend: { kind: 'cancel', confirmed: false } }, 'CANCELLATION_PENDING'],
    [{ funding: 'confirmed', spend: { kind: 'cancel', confirmed: true } }, 'CANCELLED'],
    [{ funding: 'confirmed', spend: { kind: 'unknown', confirmed: true } }, 'RECONCILIATION_REQUIRED'],
  ] as const)('derives %j as %s', (facts, expected) => {
    expect(deriveOrderState(facts)).toBe(expected);
  });
});
