import { describe, expect, it } from 'vitest';
import { FACT, poolFactName, type StoredFact } from '../../src/facts.js';
import {
  HEADER_BACKSTOP_MS,
  executableThresholdMs,
  judgeHealth,
  type HealthInputs,
} from '../../src/health/judge.js';

const TOKEN = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
const NOW = new Date('2026-11-22T12:00:00Z');
const KEEPER_SERVER = 'chipnet.imaginary.cash';
const INDEPENDENT = 'chipnet.bch.ninja';
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const fact = (value: unknown, ageMs = 1_000): StoredFact<unknown> => ({ value, observedAt: ago(ageMs) });

const healthy = (
  overrides: Partial<HealthInputs> = {},
  facts: Record<string, StoredFact<unknown> | undefined> = {},
): HealthInputs => {
  const base: Record<string, StoredFact<unknown> | undefined> = {
    [FACT.header]: fact({ height: 342_300, hash: 'aa'.repeat(32), server: KEEPER_SERVER }),
    [FACT.sweep]: fact({
      startedAt: ago(2_000).toISOString(),
      endedAt: ago(1_000).toISOString(),
      durationMs: 1_000,
    }),
    [FACT.subscriptions]: fact({ ok: true, expected: 3, subscribed: 3, intentConnectionOk: true }),
    [poolFactName(TOKEN)]: fact({ pools: 4 }),
    ...facts,
  };
  const map = new Map<string, StoredFact<unknown>>();
  for (const [name, value] of Object.entries(base)) if (value !== undefined) map.set(name, value);
  return {
    now: NOW,
    network: 'chipnet',
    sweepIntervalMs: 30_000,
    evalIntervalMs: 30_000,
    facts: map,
    evaluatorTip: { value: { height: 342_301, server: INDEPENDENT }, observedAt: ago(5_000) },
    evaluatorRunAt: ago(5_000),
    marketTokens: [TOKEN],
    executableUnfilled: [],
    vmRejectedOpenOrders: 0,
    quoteDisagreements: 0,
    ...overrides,
  };
};

describe('health judge', () => {
  it('is ok only when every check holds', () => {
    const verdict = judgeHealth(healthy());
    expect(verdict.status).toBe('ok');
    expect(verdict.reasons).toEqual([]);
    expect(verdict.checks.every((check) => check.ok)).toBe(true);
  });

  it('reports every reason when the keeper has never started', () => {
    const verdict = judgeHealth(
      healthy(
        {},
        {
          [FACT.header]: undefined,
          [FACT.sweep]: undefined,
          [FACT.subscriptions]: undefined,
          [poolFactName(TOKEN)]: undefined,
        },
      ),
    );
    expect(verdict.status).toBe('degraded');
    expect(verdict.reasons).toEqual([
      'tip_lag',
      'sweep_stale',
      'pool_data_stale',
      'subscriptions_incomplete',
    ]);
  });

  it('flags tip_lag when the keeper is more than 2 blocks behind the independent server', () => {
    expect(
      judgeHealth(
        healthy({ evaluatorTip: { value: { height: 342_302, server: INDEPENDENT }, observedAt: NOW } }),
      ).reasons,
    ).toEqual([]);
    expect(
      judgeHealth(
        healthy({ evaluatorTip: { value: { height: 342_303, server: INDEPENDENT }, observedAt: NOW } }),
      ).reasons,
    ).toEqual(['tip_lag']);
  });

  it('flags tip_lag after the wall-clock backstop since the last keeper header, per network', () => {
    const stale = {
      [FACT.header]: fact({ height: 342_300, server: KEEPER_SERVER }, HEADER_BACKSTOP_MS.chipnet + 1),
    };
    expect(judgeHealth(healthy({}, stale)).reasons).toEqual(['tip_lag']);
    const mainnet = healthy(
      { network: 'mainnet' },
      { [FACT.header]: fact({ height: 342_300, server: KEEPER_SERVER }, 30 * 60_000) },
    );
    expect(judgeHealth(mainnet).reasons).toEqual([]);
  });

  it('flags tip_lag when the evaluator reads the same Electrum server as the keeper', () => {
    // #given an evaluator that failed over onto the keeper's own server
    const shared = healthy({
      evaluatorTip: { value: { height: 342_300, server: KEEPER_SERVER }, observedAt: NOW },
    });
    // #when / #then
    expect(judgeHealth(shared).reasons).toEqual(['tip_lag']);
  });

  it('flags tip_lag when either side does not name its server', () => {
    const unnamedEvaluator = healthy({
      evaluatorTip: { value: { height: 342_300, server: null }, observedAt: NOW },
    });
    expect(judgeHealth(unnamedEvaluator).reasons).toEqual(['tip_lag']);
    const unnamedKeeper = healthy({}, { [FACT.header]: fact({ height: 342_300 }) });
    expect(judgeHealth(unnamedKeeper).reasons).toEqual(['tip_lag']);
  });

  it('flags tip_lag when the independent server lags the keeper by more than 2 blocks', () => {
    const lagging = (height: number) =>
      healthy({ evaluatorTip: { value: { height, server: INDEPENDENT }, observedAt: NOW } });
    expect(judgeHealth(lagging(342_298)).reasons).toEqual([]);
    expect(judgeHealth(lagging(342_297)).reasons).toEqual(['tip_lag']);
  });

  it('flags tip_lag when the evaluator has no independent tip', () => {
    expect(judgeHealth(healthy({ evaluatorTip: undefined })).reasons).toEqual(['tip_lag']);
  });

  it('flags sweep_stale once the last completed sweep is 2 intervals old', () => {
    expect(judgeHealth(healthy({}, { [FACT.sweep]: fact({}, 59_999) })).reasons).toEqual([]);
    expect(judgeHealth(healthy({}, { [FACT.sweep]: fact({}, 60_000) })).reasons).toEqual(['sweep_stale']);
  });

  it('flags pool_data_stale when any market has pool data 2 minutes old or none', () => {
    expect(judgeHealth(healthy({}, { [poolFactName(TOKEN)]: fact({}, 120_000) })).reasons).toEqual([
      'pool_data_stale',
    ]);
    const second = 'ab'.repeat(32);
    expect(judgeHealth(healthy({ marketTokens: [TOKEN, second] })).reasons).toEqual(['pool_data_stale']);
  });

  it('flags subscriptions_incomplete when not ok, missing or stale', () => {
    expect(judgeHealth(healthy({}, { [FACT.subscriptions]: fact({ ok: false }) })).reasons).toEqual([
      'subscriptions_incomplete',
    ]);
    expect(judgeHealth(healthy({}, { [FACT.subscriptions]: fact({ ok: true }, 60_000) })).reasons).toEqual([
      'subscriptions_incomplete',
    ]);
    expect(judgeHealth(healthy({}, { [FACT.subscriptions]: fact('yes') })).reasons).toEqual([
      'subscriptions_incomplete',
    ]);
  });

  it('flags executable_unfilled, vm_rejected and quote_disagreement from the evaluator inputs', () => {
    const verdict = judgeHealth(
      healthy({
        executableUnfilled: [{ orderId: 'x:0', since: ago(200_000) }],
        vmRejectedOpenOrders: 1,
        quoteDisagreements: 2,
      }),
    );
    expect(verdict.reasons).toEqual(['executable_unfilled', 'vm_rejected', 'quote_disagreement']);
  });

  it('flags evaluator_unavailable at once when the last evaluator run failed', () => {
    // #given a good run 5 s ago and a failure 1 s ago
    const failed = healthy({ evaluatorFailure: { at: ago(1_000), message: 'InvalidProgramState' } });
    // #then
    expect(judgeHealth(failed).reasons).toEqual(['evaluator_unavailable']);
    // #and a good run after the failure clears it
    expect(judgeHealth(healthy({ evaluatorFailure: { at: ago(10_000), message: 'x' } })).reasons).toEqual([]);
  });

  it('flags evaluator_unavailable when the evaluator has not run recently', () => {
    expect(judgeHealth(healthy({ evaluatorRunAt: undefined })).reasons).toEqual(['evaluator_unavailable']);
    expect(judgeHealth(healthy({ evaluatorRunAt: ago(2 * 30_000 + 60_000) })).reasons).toEqual([
      'evaluator_unavailable',
    ]);
  });

  it('uses 2 x sweep interval + eval interval as the executable_unfilled threshold', () => {
    expect(executableThresholdMs(30_000, 30_000)).toBe(90_000);
  });
});
