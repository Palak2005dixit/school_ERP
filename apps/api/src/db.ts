import { createPool } from '@erp/db';
import pg from 'pg';
import { config } from './config';

// Return DATE columns as plain YYYY-MM-DD strings. The API and UI work with
// calendar dates, and a JS Date would shift across timezones.
pg.types.setTypeParser(1082, (value: string) => value);


let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= createPool(config.databaseUrl);
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

/** Runs a callback inside a transaction and rolls back on any thrown error. */
export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
