import { databaseUrlParts, DATABASE_URL, PG_DATA_DIR } from './config';
import { ensureDatabase, redactUrl, startEmbeddedPostgres, waitForDatabase } from './embedded';

/**
 * `npm run dev:db` — starts the persistent local PostgreSQL cluster and keeps
 * it alive until Ctrl+C. The API connects to DATABASE_URL and retries at boot.
 */
const parts = databaseUrlParts();

console.log(`Starting embedded PostgreSQL 18 on port ${parts.port}`);
console.log(`  data directory: ${PG_DATA_DIR}`);
console.log(`  database URL:   ${redactUrl(DATABASE_URL)}`);

const handle = await startEmbeddedPostgres({ persistent: true });
await ensureDatabase(handle.instance, parts.database);
await waitForDatabase();

console.log(`Database ready: ${redactUrl(DATABASE_URL)}`);
console.log('Press Ctrl+C to stop. Data persists in .pgdata/');

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\nReceived ${signal}; stopping PostgreSQL...`);
  try {
    await handle.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Keep the event loop alive while the child postgres process runs.
setInterval(() => undefined, 60_000);
