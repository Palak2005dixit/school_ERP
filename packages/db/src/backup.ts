import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type pg from 'pg';
import { REPO_ROOT } from './config';

/**
 * Logical JSON backup and restore for the local database.
 *
 * This is intentionally not a byte-for-byte `pg_dump`: it uses PostgreSQL's
 * `to_jsonb` / `jsonb_populate_record` so dates, numerics and JSONB round-trip
 * without losing precision. Restore requires the target to be migrated and
 * empty (the CLI truncates all data tables first). It is a local-only safety
 * net, not a replacement for point-in-time recovery in production.
 */

const FORMAT = 'school-erp-json-backup';
const VERSION = 1;

interface TableDump {
  name: string;
  rows: unknown[];
}

export interface BackupSummary {
  path: string;
  tables: number;
  rows: number;
  createdAt: string;
}

interface BackupFile {
  format: typeof FORMAT;
  version: typeof VERSION;
  createdAt: string;
  database: string;
  tables: TableDump[];
}

export function defaultBackupPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return resolve(REPO_ROOT, 'backups', `school-erp-${stamp}.json`);
}

export async function backupDatabase(
  pool: pg.Pool,
  filePath = defaultBackupPath(),
): Promise<BackupSummary> {
  const tables = await listDataTables(pool);
  const dumps: TableDump[] = [];
  let rowCount = 0;

  const client = await pool.connect();
  try {
    // A repeatable snapshot keeps every table consistent with each other.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const table of tables) {
      const { rows } = await client.query<{ row: unknown }>(
        `SELECT to_jsonb(t) AS row FROM ${quoteIdent(table)} t`,
      );
      rowCount += rows.length;
      dumps.push({ name: table, rows: rows.map((row) => row.row) });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
  const payload: BackupFile = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    database: database.rows[0]?.name ?? 'unknown',
    tables: dumps,
  };

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path: filePath, tables: dumps.length, rows: rowCount, createdAt: payload.createdAt };
}

export interface RestoreSummary {
  path: string;
  tables: number;
  rows: number;
  createdAt: string;
}

/**
 * Restores a JSON backup. Every data table is truncated first, so this always
 * requires `confirmed: true`; the CLI only sets it when `--yes` is passed.
 */
export async function restoreDatabase(
  pool: pg.Pool,
  filePath: string,
  options: { confirmed: boolean },
): Promise<RestoreSummary> {
  if (!options.confirmed) {
    throw new Error('Restore wipes existing data. Re-run with --yes to confirm.');
  }

  const raw = await readFile(filePath, 'utf8');
  const payload = JSON.parse(raw) as BackupFile;
  if (payload.format !== FORMAT || payload.version !== VERSION) {
    throw new Error('This file is not a supported School ERP JSON backup');
  }

  const known = new Set(await listDataTables(pool));
  for (const table of payload.tables) {
    if (!known.has(table.name)) {
      throw new Error(`Backup contains an unknown table: ${table.name}`);
    }
  }

  const ordered = await dependencyOrder(pool, payload.tables.map((table) => table.name));
  const byName = new Map(payload.tables.map((table) => [table.name, table]));
  const client = await pool.connect();
  let rowCount = 0;
  try {
    await client.query('BEGIN');
    const allTables = [...known].map(quoteIdent).join(', ');
    await client.query(`TRUNCATE ${allTables} RESTART IDENTITY CASCADE`);
    for (const table of ordered) {
      const dump = byName.get(table);
      if (!dump) continue;
      for (const row of dump.rows) {
        await client.query(
          `INSERT INTO ${quoteIdent(table)}
           SELECT * FROM jsonb_populate_record(NULL::${quoteIdent(table)}, $1::jsonb)`,
          [JSON.stringify(row)],
        );
        rowCount += 1;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return {
    path: filePath,
    tables: payload.tables.length,
    rows: rowCount,
    createdAt: payload.createdAt,
  };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function listDataTables(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT c.relname AS name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname <> 'schema_migrations'
     ORDER BY c.relname`,
  );
  return rows.map((row) => row.name);
}

/** Topologically sorts tables so referenced tables are inserted first. */
async function dependencyOrder(pool: pg.Pool, tables: string[]): Promise<string[]> {
  const { rows } = await pool.query<{ child: string; parent: string }>(
    `SELECT child.relname AS child, parent.relname AS parent
     FROM pg_constraint c
     JOIN pg_class child ON child.oid = c.conrelid
     JOIN pg_class parent ON parent.oid = c.confrelid
     JOIN pg_namespace n ON n.oid = child.relnamespace
     WHERE c.contype = 'f'
       AND n.nspname = 'public'
       AND child.relname <> parent.relname`,
  );

  const wanted = new Set(tables);
  const parents = new Map<string, Set<string>>();
  for (const table of tables) parents.set(table, new Set());
  for (const edge of rows) {
    if (!wanted.has(edge.child) || !wanted.has(edge.parent)) continue;
    parents.get(edge.child)!.add(edge.parent);
  }

  const ordered: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();

  function visit(table: string): void {
    if (done.has(table)) return;
    if (visiting.has(table)) {
      // Circular FK: break the cycle and let the insert fail loudly if the
      // data really is impossible to order.
      return;
    }
    visiting.add(table);
    for (const parent of parents.get(table) ?? []) visit(parent);
    visiting.delete(table);
    done.add(table);
    ordered.push(table);
  }

  for (const table of tables) visit(table);
  return ordered;
}
