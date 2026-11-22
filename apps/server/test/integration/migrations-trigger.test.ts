import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORDER_STATUSES, ORDER_STATUS_PAIRS, type OrderStatus } from '@atprice/core';
import { MIGRATIONS_DIR, MigrationChecksumError, migrate } from '../../src/db/migrate.js';
import type { Db } from '../../src/db/pool.js';
import { freshDb } from '../support/db.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
});

const TXID = 'ab'.repeat(32);
let seq = 0;

const insertOrder = async (status: OrderStatus): Promise<string> => {
  seq += 1;
  const id = `${TXID}:${seq}`;
  await db.query(
    `INSERT INTO orders (id, network, instance_kind, funding_txid, funding_vout, side, owner_pkh, owner_address,
       recipient_locking_bytecode, token_id, min_out, max_network_fee, nonce, contract_version, order_address,
       order_locking_bytecode, satoshis, supported, status)
     VALUES ($1, 'chipnet', 'funding', $2, $3, 'buy', $4, 'bchtest:q', '76a9', $5, 1, 2000, '0102030405060708', 'v1:x',
       'bchtest:p', 'aa20', 60000, true, $6)`,
    [
      id,
      TXID,
      seq,
      '11'.repeat(20),
      'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b',
      status,
    ],
  );
  return id;
};

const legal = new Set(ORDER_STATUS_PAIRS.map(([from, to]) => `${from ?? '-'}>${to}`));

describe('migrations', () => {
  it('records each applied migration and skips it on a second run', async () => {
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
    expect(again.skipped).toContain('0001_initial');
  });

  it('refuses to run when an applied migration file was edited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atprice-migrations-'));
    const original = await readFile(join(MIGRATIONS_DIR, '0001_initial.sql'), 'utf8');
    await writeFile(join(dir, '0001_initial.sql'), `${original}\n-- edited`);
    await expect(migrate(db, `${dir}/`)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('creates every table architecture.md r5 lists', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'orders',
        'order_intents',
        'executions',
        'transaction_events',
        'keeper_attempts',
        'markets',
        'keeper_facts',
        'evaluator_orders',
        'evaluator_state',
        'order_status_edges',
      ]),
    );
  });
});

describe('order status trigger', () => {
  it('holds exactly the edge set of the core transition table', async () => {
    const { rows } = await db.query<{ from_status: string | null; to_status: string }>(
      'SELECT from_status, to_status FROM order_status_edges',
    );
    const stored = new Set(rows.map((row) => `${row.from_status ?? '-'}>${row.to_status}`));
    expect(stored).toEqual(legal);
  });

  it.each(ORDER_STATUSES.map((status) => [status]))(
    'allows creating an order directly in %s only if the table says so',
    async (status) => {
      const attempt = insertOrder(status);
      if (legal.has(`->${status}`)) await expect(attempt).resolves.toBeTypeOf('string');
      else await expect(attempt).rejects.toThrow(/illegal order status edge/);
    },
  );

  const pairs = ORDER_STATUSES.flatMap((from) =>
    ORDER_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it.each(pairs)('%s -> %s is accepted exactly when the core table has the edge', async (from, to) => {
    const id = await insertOrder(from);
    const update = db.query('UPDATE orders SET status = $2 WHERE id = $1', [id, to]);
    if (legal.has(`${from}>${to}`)) await expect(update).resolves.toBeDefined();
    else await expect(update).rejects.toThrow(/illegal order status edge/);
  });

  it.each(ORDER_STATUSES.map((status) => [status]))(
    'treats a same-status update of %s as a no-op, never a rejection',
    async (status) => {
      const id = await insertOrder(status);
      await expect(
        db.query('UPDATE orders SET status = $2, vanish_sweeps = 1 WHERE id = $1', [id, status]),
      ).resolves.toBeDefined();
    },
  );

  it.each(ORDER_STATUSES.map((status) => [status]))(
    'allows deleting a %s order only from FUNDING_PENDING',
    async (status) => {
      const id = await insertOrder(status);
      const removal = db.query('DELETE FROM orders WHERE id = $1', [id]);
      if (status === 'FUNDING_PENDING') await expect(removal).resolves.toBeDefined();
      else await expect(removal).rejects.toThrow(/illegal order status edge/);
    },
  );

  it('keeps transaction events of a deleted order', async () => {
    const id = await insertOrder('FUNDING_PENDING');
    await db.query(
      `INSERT INTO transaction_events (order_id, network, cause, decision, network_state) VALUES ($1, 'chipnet', 'funding_seen', 'transition', 'mempool')`,
      [id],
    );
    await db.query('DELETE FROM orders WHERE id = $1', [id]);
    const { rows } = await db.query('SELECT 1 FROM transaction_events WHERE order_id = $1', [id]);
    expect(rows).toHaveLength(1);
  });
});
