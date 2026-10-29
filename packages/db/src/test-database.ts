import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createPool, runMigrations, seedDemoData } from './index';
import { ensureDatabase, startEmbeddedPostgres, waitForDatabase } from './embedded';

/**
 * Asks the OS for an unused loopback port so parallel or interrupted test runs
 * never collide on a fixed port.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

export interface TestDatabase {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Boots a throwaway PostgreSQL cluster for integration tests. The data
 * directory lives in the OS temp folder and is deleted on stop.
 */
export async function startTestDatabase(options?: {
  port?: number;
  database?: string;
}): Promise<TestDatabase> {
  const port = options?.port ?? (await findFreePort());
  const database = options?.database ?? 'school_erp_test';
  const dataDir = path.join(os.tmpdir(), `school-erp-test-${process.pid}-${Date.now()}`);
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;

  const handle = await startEmbeddedPostgres({
    dataDir,
    persistent: false,
    port,
    log: false,
  });

  await ensureDatabase(handle.instance, database);
  await waitForDatabase(url);

  const pool = createPool(url);
  try {
    await runMigrations(pool);
    const client = await pool.connect();
    try {
      await seedDemoData(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  return {
    url,
    stop: async () => {
      await handle.stop();
    },
  };
}
