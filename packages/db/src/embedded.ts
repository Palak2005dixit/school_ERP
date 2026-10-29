import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {
  DATABASE_URL,
  databaseUrlParts,
  needsInitialise,
  PG_DATA_DIR,
} from './config';

export interface EmbeddedHandle {
  instance: EmbeddedPostgres;
  stop: () => Promise<void>;
}

/**
 * Starts embedded PostgreSQL for local development and tests.
 * Supabase connections should use pingDatabase with the configured URL.
 */
export async function startEmbeddedPostgres(options?: {
  dataDir?: string;
  persistent?: boolean;
  port?: number;
  log?: boolean;
}): Promise<EmbeddedHandle> {
  const dataDir = options?.dataDir ?? PG_DATA_DIR;
  const parts = databaseUrlParts();
  const port = options?.port ?? parts.port;
  const log = options?.log ?? true;

  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: parts.user,
    password: parts.password,
    port,
    persistent: options?.persistent ?? true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: log
      ? (message) => console.log(`[postgres] ${message.trim()}`)
      : () => {},
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : String(error);

      // Expected connection noise while the embedded server shuts down.
      if (/ECONNRESET|Connection terminated/i.test(message)) return;

      if (log) console.error('[postgres]', message);
    },
  });

  if (needsInitialise(dataDir)) {
    await instance.initialise();
  }

  await instance.start();

  return {
    instance,
    stop: async () => {
      await instance.stop();
    },
  };
}

/** Creates the application database when it does not exist yet. */
export async function ensureDatabase(
  instance: EmbeddedPostgres,
  database: string,
): Promise<void> {
  try {
    await instance.createDatabase(database);
  } catch (error) {
    const code = (error as { code?: string }).code;

    // 42P04 = duplicate_database.
    if (code !== '42P04') throw error;
  }
}

/**
 * Checks whether PostgreSQL is reachable.
 * Logs the actual connection error without exposing the connection URL.
 */
export async function pingDatabase(
  url: string = DATABASE_URL,
): Promise<boolean> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    application_name: 'school-erp-db-diagnostic',
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch (error) {
    if (error instanceof Error) {
      const details = error as Error & {
        code?: string;
        detail?: string;
      };

      console.error(
        '[database] Connection failed:',
        details.message,
        details.code ? `(code: ${details.code})` : '',
      );
    } else {
      console.error('[database] Connection failed:', String(error));
    }

    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Waits for PostgreSQL to accept connections after startup. */
export async function waitForDatabase(
  url: string = DATABASE_URL,
  attempts = 40,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await pingDatabase(url)) return;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Database at ${redactUrl(url)} did not become ready`,
  );
}

/** Redacts the password before displaying a connection URL. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.password) parsed.password = '***';

    // Also redact credentials if a URL contains them in query parameters.
    for (const key of [
      'password',
      'pass',
      'token',
      'secret',
      'api_key',
    ]) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '***');
      }
    }

    return parsed.toString();
  } catch {
    return '[database URL hidden]';
  }
}