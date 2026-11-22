import { createDb } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { EnvValidationError, loadMigrateEnv } from './env.js';
import { createLogger } from './logger.js';

const logger = createLogger('migrate', process.env.LOG_LEVEL ?? 'info');

try {
  const { databaseUrl } = loadMigrateEnv();
  const db = createDb(databaseUrl, 'atprice-migrate');
  try {
    const result = await migrate(db);
    logger.info({ applied: result.applied, skipped: result.skipped.length }, 'migrations complete');
  } finally {
    await db.end();
  }
} catch (error) {
  if (error instanceof EnvValidationError) {
    logger.fatal({ issues: error.issues }, 'invalid environment');
  } else {
    logger.fatal({ err: error }, 'migration failed');
  }
  process.exitCode = 1;
}
