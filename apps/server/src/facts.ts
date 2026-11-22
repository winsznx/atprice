import type { Queryable } from './db/pool.js';

/**
 * Keeper facts (architecture.md, health): one row per name with the observed value and when it was
 * observed. Values are plain JSON; amounts and heights are numbers or decimal strings.
 */
export const FACT = {
  header: 'header',
  electrum: 'electrum',
  subscriptions: 'subscriptions_ok',
  sweep: 'sweep',
  sweepStarted: 'sweep_started',
  lastAttempt: 'last_attempt',
  lastBroadcast: 'last_broadcast_txid',
  lastConfirmedFill: 'last_confirmed_fill_txid',
  reactionLatency: 'reaction_latency',
  keeperBoot: 'keeper_boot',
} as const;

export const poolFactName = (tokenId: string): string => `pool:${tokenId}`;

export interface HeaderFact {
  readonly height: number;
  readonly hash: string;
  readonly server: string;
}

/** The Electrum server named in a stored header fact, if it names one. */
export const headerServer = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null || !('server' in value)) return undefined;
  return typeof value.server === 'string' ? value.server : undefined;
};

/**
 * Writes the keeper's header fact only if it is not lower than the one stored, atomically, so a
 * lagging server after failover or a header handled out of order can never move the recorded tip back
 * (and its `observed_at` keeps ageing until the keeper's server passes the recorded height).
 */
export const writeHeaderFact = async (
  db: Queryable,
  network: string,
  header: HeaderFact,
): Promise<boolean> => {
  const result = await db.query(
    `INSERT INTO keeper_facts (network, name, value, observed_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (network, name) DO UPDATE SET value = EXCLUDED.value, observed_at = EXCLUDED.observed_at
       WHERE COALESCE((keeper_facts.value->>'height')::bigint, -1) <= (EXCLUDED.value->>'height')::bigint`,
    [network, FACT.header, JSON.stringify(header)],
  );
  return (result.rowCount ?? 0) > 0;
};

/** Written only when a sweep completes; `sweep_started` marks the start of the one in progress. */
export interface SweepFact {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
}

export interface SubscriptionsFact {
  readonly ok: boolean;
  readonly expected: number;
  readonly subscribed: number;
  readonly intentConnectionOk: boolean;
}

export interface StoredFact<T> {
  readonly value: T;
  readonly observedAt: Date;
}

export const writeFact = async (
  db: Queryable,
  network: string,
  name: string,
  value: unknown,
  observedAt?: Date,
): Promise<void> => {
  await db.query(
    `INSERT INTO keeper_facts (network, name, value, observed_at) VALUES ($1, $2, $3, COALESCE($4, now()))
     ON CONFLICT (network, name) DO UPDATE SET value = EXCLUDED.value, observed_at = EXCLUDED.observed_at`,
    [network, name, JSON.stringify(value), observedAt ?? null],
  );
};

export const readFacts = async (
  db: Queryable,
  network: string,
): Promise<Map<string, StoredFact<unknown>>> => {
  const { rows } = await db.query<{ name: string; value: unknown; observed_at: Date }>(
    'SELECT name, value, observed_at FROM keeper_facts WHERE network = $1',
    [network],
  );
  return new Map(rows.map((row) => [row.name, { value: row.value, observedAt: row.observed_at }]));
};
