import { pino } from 'pino';
import type { Analytics, AnalyticsEvent, AnalyticsFields } from '../../src/analytics.js';
import { migrate } from '../../src/db/migrate.js';
import { createDb, type Db } from '../../src/db/pool.js';

/** Integration tests run against a dedicated database, never the dev one. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mac@/atprice_test?host=/tmp';

export const silentLogger = pino({ level: 'silent' });

/** Drops and recreates the schema, then applies every migration. */
export const freshDb = async (): Promise<Db> => {
  if (!TEST_DATABASE_URL.includes('atprice_test'))
    throw new Error('refusing to reset a database that is not atprice_test');
  const db = createDb(TEST_DATABASE_URL, 'atprice-test');
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await migrate(db);
  return db;
};

export const count = async (db: Db, sql: string, params: unknown[] = []): Promise<number> => {
  const { rows } = await db.query<{ count: string }>(sql, params);
  return Number(rows[0]?.count ?? 0);
};

export interface RecordedEvent {
  readonly event: AnalyticsEvent;
  readonly fields: AnalyticsFields;
}

/** Analytics that keeps every event in memory, so tests can assert on what the server emitted. */
export const recordingAnalytics = (): Analytics & { readonly events: RecordedEvent[] } => {
  const events: RecordedEvent[] = [];
  return { events, emit: (event, fields) => events.push({ event, fields }) };
};

export const testAnalytics = recordingAnalytics();
