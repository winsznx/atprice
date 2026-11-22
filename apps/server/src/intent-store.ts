import { withTransaction, type Db } from './db/pool.js';

/** Intent watch caps (architecture.md, order creation step 2). */
export const INTENTS_PER_CLIENT_PER_HOUR = 20;
export const LIVE_INTENTS_GLOBAL = 2_000;
export const INTENT_TTL_MS = 24 * 60 * 60_000;

export interface IntentInput {
  readonly network: string;
  readonly orderAddress: string;
  readonly orderLockingBytecode: string;
  readonly side: string;
  readonly tokenId: string;
  readonly amount: string;
  readonly params: unknown;
  readonly clientPrefix: string;
  readonly expiresAt: Date;
}

export interface StoredIntent {
  readonly id: string;
  readonly expires_at: Date;
  readonly status: string;
}

export type IntentResult =
  | { readonly kind: 'stored'; readonly intent: StoredIntent }
  | { readonly kind: 'intent_rate_limited' }
  | { readonly kind: 'intent_capacity' };

/**
 * Checks both caps and inserts in one transaction under a per-network advisory lock, so concurrent
 * requests cannot all read the same count and all insert. An intent counts against the global cap only
 * while it is live and unexpired; every intent created in the last hour counts against its client.
 */
export const storeIntent = (db: Db, input: IntentInput): Promise<IntentResult> =>
  withTransaction(db, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('atprice:order_intents:' || $1, 0))`, [
      input.network,
    ]);
    const { rows: counts } = await client.query<{ client: string; live: string }>(
      `SELECT count(*) FILTER (WHERE client_prefix = $2 AND created_at > now() - interval '1 hour') AS client,
              count(*) FILTER (WHERE status = 'live' AND expires_at > now()) AS live
         FROM order_intents WHERE network = $1`,
      [input.network, input.clientPrefix],
    );
    if (Number(counts[0]?.client ?? 0) >= INTENTS_PER_CLIENT_PER_HOUR) return { kind: 'intent_rate_limited' };
    if (Number(counts[0]?.live ?? 0) >= LIVE_INTENTS_GLOBAL) return { kind: 'intent_capacity' };
    const { rows } = await client.query<StoredIntent>(
      `INSERT INTO order_intents (network, order_address, order_locking_bytecode, side, token_id, amount, params, client_prefix, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (network, order_locking_bytecode) DO UPDATE SET expires_at = GREATEST(order_intents.expires_at, EXCLUDED.expires_at)
       RETURNING id, expires_at, status`,
      [
        input.network,
        input.orderAddress,
        input.orderLockingBytecode,
        input.side,
        input.tokenId,
        input.amount,
        JSON.stringify(input.params),
        input.clientPrefix,
        input.expiresAt,
      ],
    );
    const intent = rows[0];
    if (intent === undefined) throw new Error('intent insert returned no row');
    return { kind: 'stored', intent };
  });

/** Full client IPv4 addresses are kept only for the one-hour per-client window, then cut to their /24. */
export const CLIENT_PREFIX_RETENTION = '1 hour';
/** Expired and funded intents (and their truncated prefixes) are deleted after this (architecture.md, API). */
export const INTENT_RETENTION = '7 days';

export interface IntentPurge {
  readonly truncated: number;
  readonly deleted: number;
}

/** The privacy half of the intent sweep: truncate old client addresses and delete settled old intents. */
export const purgeIntentPrivacy = async (db: Db, network: string): Promise<IntentPurge> => {
  const truncated = await db.query(
    `UPDATE order_intents SET client_prefix = regexp_replace(client_prefix, '\\.\\d+$', '.0/24')
      WHERE network = $1 AND created_at < now() - $2::interval AND client_prefix ~ '^\\d+\\.\\d+\\.\\d+\\.\\d+$'`,
    [network, CLIENT_PREFIX_RETENTION],
  );
  const deleted = await db.query(
    `DELETE FROM order_intents
      WHERE network = $1 AND status IN ('expired', 'funded') AND created_at < now() - $2::interval`,
    [network, INTENT_RETENTION],
  );
  return { truncated: truncated.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
};
