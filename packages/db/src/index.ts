import pg from 'pg';
import { DATABASE_URL } from './config';

export { DATABASE_URL, PG_DATA_DIR, MIGRATIONS_DIR, databaseUrlParts, isLocalDatabase, REPO_ROOT } from './config';
export { runMigrations } from './migrate';
export type { MigrationResult } from './migrate';
export { seedDemoData, DEMO_PASSWORD } from './seed';
export type { SeedResult } from './seed';
export { backupDatabase, defaultBackupPath, restoreDatabase } from './backup';
export type { BackupSummary, RestoreSummary } from './backup';
export {
  startEmbeddedPostgres,
  ensureDatabase,
  pingDatabase,
  waitForDatabase,
  redactUrl,
} from './embedded';
export type { EmbeddedHandle } from './embedded';

export function createPool(connectionString: string = DATABASE_URL): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'school-erp-api',
  });
}
