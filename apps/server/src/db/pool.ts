import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export const createDb = (databaseUrl: string, applicationName: string): Db => {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: applicationName,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client error (server restart) must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  return pool;
};

/** Runs `work` in one transaction, rolling back on any throw. */
export const withTransaction = async <T>(db: Db, work: (client: DbClient) => Promise<T>): Promise<T> => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};
