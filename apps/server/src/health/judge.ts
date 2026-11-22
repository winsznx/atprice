import type { Network } from '@atprice/core';
import { FACT, poolFactName, type StoredFact } from '../facts.js';

export const HEALTH_REASONS = [
  'tip_lag',
  'sweep_stale',
  'pool_data_stale',
  'subscriptions_incomplete',
  'executable_unfilled',
  'vm_rejected',
  'quote_disagreement',
  'evaluator_unavailable',
] as const;

export type HealthReason = (typeof HEALTH_REASONS)[number];

export interface HealthInputs {
  readonly now: Date;
  readonly network: Network;
  readonly sweepIntervalMs: number;
  readonly evalIntervalMs: number;
  readonly facts: ReadonlyMap<string, StoredFact<unknown>>;
  /** The independent evaluator's own reading of the tip, and the Electrum server it read it from. */
  readonly evaluatorTip: StoredFact<{ readonly height: number; readonly server: string | null }> | undefined;
  readonly evaluatorRunAt: Date | undefined;
  /** The evaluator's last failed run, if any; a failure newer than the last good run is unavailability. */
  readonly evaluatorFailure?: { readonly at: Date; readonly message: string } | undefined;
  readonly marketTokens: readonly string[];
  /** Orders the evaluator has found executable for longer than the threshold. */
  readonly executableUnfilled: readonly { readonly orderId: string; readonly since: Date }[];
  readonly vmRejectedOpenOrders: number;
  readonly quoteDisagreements: number;
}

export interface HealthCheck {
  readonly reason: HealthReason;
  readonly ok: boolean;
  readonly detail: string;
}

export interface HealthVerdict {
  readonly status: 'ok' | 'degraded';
  readonly reasons: readonly HealthReason[];
  readonly checks: readonly HealthCheck[];
}

/** Tip lag tolerated in blocks, and the wall-clock backstop since the keeper's last header. */
export const TIP_LAG_BLOCKS = 2;
export const HEADER_BACKSTOP_MS: Readonly<Record<Network, number>> = {
  mainnet: 60 * 60_000,
  chipnet: 10 * 60_000,
};
export const POOL_DATA_MAX_AGE_MS = 2 * 60_000;

/** `executable_unfilled` threshold: 2 x KEEPER_SWEEP_INTERVAL_MS + HEALTH_EVAL_INTERVAL_MS. */
export const executableThresholdMs = (sweepIntervalMs: number, evalIntervalMs: number): number =>
  2 * sweepIntervalMs + evalIntervalMs;

const age = (now: Date, at: Date): number => now.getTime() - at.getTime();

const numberField = (value: unknown, field: string): number | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'number' ? candidate : undefined;
};

const stringField = (value: unknown, field: string): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : undefined;
};

const booleanField = (value: unknown, field: string): boolean | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'boolean' ? candidate : undefined;
};

/**
 * Judges keeper facts and the evaluator's own observations against wall-clock thresholds
 * (architecture.md, health that cannot lie). Pure: everything it needs is in `inputs`.
 */
export const judgeHealth = (inputs: HealthInputs): HealthVerdict => {
  const { now, facts } = inputs;
  const checks: HealthCheck[] = [];
  const check = (reason: HealthReason, ok: boolean, detail: string): void => {
    checks.push({ reason, ok, detail });
  };

  const header = facts.get(FACT.header);
  const keeperHeight = numberField(header?.value, 'height');
  const keeperServer = stringField(header?.value, 'server');
  const backstop = HEADER_BACKSTOP_MS[inputs.network];
  const independent = inputs.evaluatorTip?.value;
  if (header === undefined || keeperHeight === undefined) {
    check('tip_lag', false, 'the keeper has reported no header');
  } else if (age(now, header.observedAt) > backstop) {
    check(
      'tip_lag',
      false,
      `no keeper header for ${Math.round(age(now, header.observedAt) / 1000)} s (backstop ${backstop / 1000} s)`,
    );
  } else if (independent === undefined) {
    check('tip_lag', false, 'the evaluator has no independent tip to compare with');
  } else if (
    independent.server === null ||
    keeperServer === undefined ||
    independent.server === keeperServer
  ) {
    // A comparison against the keeper's own server proves nothing about the keeper being current.
    check(
      'tip_lag',
      false,
      `the evaluator and the keeper do not read distinct Electrum servers (keeper ${keeperServer ?? 'unknown'}, evaluator ${independent.server ?? 'unknown'})`,
    );
  } else if (independent.height - keeperHeight > TIP_LAG_BLOCKS) {
    check('tip_lag', false, `keeper at ${keeperHeight}, independent server at ${independent.height}`);
  } else if (keeperHeight - independent.height > TIP_LAG_BLOCKS) {
    check(
      'tip_lag',
      false,
      `independent server ${independent.server} at ${independent.height} lags the keeper at ${keeperHeight}; it cannot confirm the keeper's tip`,
    );
  } else {
    check(
      'tip_lag',
      true,
      `keeper at ${keeperHeight} on ${keeperServer}, independent server ${independent.server} at ${independent.height}`,
    );
  }

  const sweep = facts.get(FACT.sweep);
  const sweepLimit = 2 * inputs.sweepIntervalMs;
  if (sweep === undefined) check('sweep_stale', false, 'the keeper has never completed a sweep');
  else if (age(now, sweep.observedAt) >= sweepLimit) {
    check('sweep_stale', false, `last sweep finished ${Math.round(age(now, sweep.observedAt) / 1000)} s ago`);
  } else
    check('sweep_stale', true, `last sweep finished ${Math.round(age(now, sweep.observedAt) / 1000)} s ago`);

  const stalePools = inputs.marketTokens.filter((token) => {
    const fact = facts.get(poolFactName(token));
    return fact === undefined || age(now, fact.observedAt) >= POOL_DATA_MAX_AGE_MS;
  });
  check(
    'pool_data_stale',
    stalePools.length === 0,
    stalePools.length === 0
      ? 'every market has pool data younger than 2 minutes'
      : `stale or missing pool data: ${stalePools.join(', ')}`,
  );

  const subscriptions = facts.get(FACT.subscriptions);
  const subscriptionsOk = booleanField(subscriptions?.value, 'ok');
  if (subscriptions === undefined || subscriptionsOk === undefined) {
    check('subscriptions_incomplete', false, 'the keeper has not reported its subscriptions');
  } else if (!subscriptionsOk) {
    check('subscriptions_incomplete', false, 'not every OPEN, pending and live-intent address is subscribed');
  } else if (age(now, subscriptions.observedAt) >= sweepLimit) {
    check('subscriptions_incomplete', false, 'the subscriptions fact is older than two sweep intervals');
  } else check('subscriptions_incomplete', true, 'every tracked address is subscribed');

  const unfilled = inputs.executableUnfilled;
  check(
    'executable_unfilled',
    unfilled.length === 0,
    unfilled.length === 0
      ? 'no order has been executable beyond the threshold'
      : `${unfilled.length} executable order(s) unfilled, oldest since ${unfilled
          .map((entry) => entry.since)
          .sort((a, b) => a.getTime() - b.getTime())[0]
          ?.toISOString()}`,
  );

  check(
    'vm_rejected',
    inputs.vmRejectedOpenOrders === 0,
    inputs.vmRejectedOpenOrders === 0
      ? 'no OPEN order has a vm_rejected attempt'
      : `${inputs.vmRejectedOpenOrders} OPEN order(s) with vm_rejected`,
  );

  check(
    'quote_disagreement',
    inputs.quoteDisagreements === 0,
    inputs.quoteDisagreements === 0
      ? 'keeper and evaluator quotes agree'
      : `${inputs.quoteDisagreements} quote disagreement(s)`,
  );

  const evaluatorLimit = 2 * inputs.evalIntervalMs + 60_000;
  const failure = inputs.evaluatorFailure;
  const runAt = inputs.evaluatorRunAt;
  if (failure !== undefined && (runAt === undefined || failure.at >= runAt)) {
    check('evaluator_unavailable', false, `the last evaluator run failed: ${failure.message}`);
  } else if (runAt === undefined) {
    check('evaluator_unavailable', false, 'the evaluator has not completed a run');
  } else {
    check(
      'evaluator_unavailable',
      age(now, runAt) < evaluatorLimit,
      `last evaluator run ${Math.round(age(now, runAt) / 1000)} s ago`,
    );
  }

  const reasons = checks.filter((entry) => !entry.ok).map((entry) => entry.reason);
  return { status: reasons.length === 0 ? 'ok' : 'degraded', reasons, checks };
};
