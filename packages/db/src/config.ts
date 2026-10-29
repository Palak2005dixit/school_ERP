import 'dotenv/config';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/school_erp';

export const PG_DATA_DIR = process.env.PG_DATA_DIR ?? path.join(REPO_ROOT, '.pgdata');

export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'packages', 'db', 'migrations');

export function databaseUrlParts(url: string = DATABASE_URL): {
  port: number;
  database: string;
  user: string;
  password: string;
  host: string;
} {
  const parsed = new URL(url);
  return {
    port: Number(parsed.port || 5432),
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || 'postgres'),
    host: parsed.hostname,
  };
}

export function isLocalDatabase(url: string = DATABASE_URL): boolean {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * True when the embedded cluster needs `initdb`. A directory can exist while
 * an interrupted init left it unusable, so the PG_VERSION marker is the test.
 */
export function needsInitialise(dataDir: string = PG_DATA_DIR): boolean {
  return !existsSync(path.join(dataDir, 'PG_VERSION'));
}
