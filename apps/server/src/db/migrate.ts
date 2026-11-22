import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Arbitrary constant: one migrator at a time across api, keeper and the CLI. */
const MIGRATION_LOCK_KEY = 4_072_518_331;

export class MigrationChecksumError extends Error {
  readonly reason = 'migration_checksum_mismatch';
  constructor(readonly version: string) {
    super(`migration ${version} was changed after it was applied; add a new migration instead`);
    this.name = 'MigrationChecksumError';
  }
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

/** Applies every `NNNN_name.sql` in order, each in its own transaction, under an advisory lock. */
export const migrate = async (db: Db, directory = MIGRATIONS_DIR): Promise<MigrationResult> => {
  const files = (await readdir(directory)).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  const client = await db.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((row) => [row.version, row.checksum]));
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = await readFile(`${directory}${file}`, 'utf8');
      const sum = checksum(sql);
      const previous = done.get(version);
      if (previous !== undefined) {
        if (previous !== sum) throw new MigrationChecksumError(version);
        skipped.push(version);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          version,
          sum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(version);
    }
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
};
