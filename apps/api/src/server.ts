import { waitForDatabase } from '@erp/db';
import { buildApp } from './app';
import { config } from './config';
import { closePool } from './db';

const app = await buildApp({ logger: true });

try {
  await waitForDatabase(config.databaseUrl, 60);
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`API listening on http://localhost:${config.port}`);
  app.log.info(`Allowed browser origin: ${config.appOrigin}`);
} catch (error) {
  app.log.error(error, 'Failed to start API');
  await closePool();
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`Received ${signal}; shutting down`);
  try {
    await app.close();
    await closePool();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
