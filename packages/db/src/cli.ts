import {
  backupDatabase,
  createPool,
  databaseUrlParts,
  DATABASE_URL,
  defaultBackupPath,
  ensureDatabase,
  isLocalDatabase,
  pingDatabase,
  redactUrl,
  restoreDatabase,
  runMigrations,
  seedDemoData,
  startEmbeddedPostgres,
  waitForDatabase,
} from './index';
import type { EmbeddedHandle } from './index';
import { resolve } from 'node:path';

/**
 * Applies or seeds the database described by DATABASE_URL. If nothing is
 * listening on a local URL, a temporary embedded PostgreSQL cluster is started
 * for the duration of the command — this makes `npm run db:setup` work on a
 * clean machine without Docker or a system PostgreSQL install.
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  const commands = new Set(['migrate', 'seed', 'setup', 'reset', 'backup', 'restore', 'help']);

  if (!commands.has(command)) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (command === 'help') {
    printHelp();
    return;
  }

  const parts = databaseUrlParts();
  let handle: EmbeddedHandle | undefined;

  if (!(await pingDatabase())) {
    if (!isLocalDatabase()) {
      throw new Error(
        `Cannot reach ${redactUrl(DATABASE_URL)}. Start the server or fix DATABASE_URL.`,
      );
    }
    console.log(`No database at ${redactUrl(DATABASE_URL)}; starting embedded PostgreSQL...`);
    handle = await startEmbeddedPostgres({ persistent: true, log: false });
    await ensureDatabase(handle.instance, parts.database);
    await waitForDatabase();
  }

  const pool = createPool();

  try {
    if (command === 'reset') {
      if (process.env.NODE_ENV === 'production' || !isLocalDatabase()) {
        throw new Error('Refusing to reset a non-local database');
      }
      console.log('Dropping and recreating the public schema (local only)...');
      await pool.query('DROP SCHEMA public CASCADE');
      await pool.query('CREATE SCHEMA public');
    }

    if (command === 'reset' || command === 'setup' || command === 'migrate') {
      const result = await runMigrations(pool);
      console.log(`Migrations applied: ${result.applied.length}`);
      for (const file of result.applied) console.log(`  + ${file}`);
      if (result.skipped.length > 0) console.log(`Already up to date: ${result.skipped.length}`);
    }

    if (command === 'reset' || command === 'setup' || command === 'seed') {
      const client = await pool.connect();
      try {
        const result = await seedDemoData(client);
        console.log(`Seed complete. School: ${result.schoolId}`);
        console.log(`  students created: ${result.studentsCreated}`);
        console.log(`  users created:    ${result.usersCreated}`);
        console.log('Demo logins are listed in README.md (synthetic data only).');
      } finally {
        client.release();
      }
    }

    if (command === 'backup') {
      const target = process.argv[3] ? resolve(process.argv[3]) : defaultBackupPath();
      const result = await backupDatabase(pool, target);
      console.log(`Backup written to ${result.path}`);
      console.log(`  tables: ${result.tables}`);
      console.log(`  rows:   ${result.rows}`);
    }

    if (command === 'restore') {
      if (process.env.NODE_ENV === 'production' || !isLocalDatabase()) {
        throw new Error('Refusing to restore over a non-local database');
      }
      const source = process.argv[3];
      if (!source) throw new Error('Usage: db:restore <backup-file> --yes');
      const confirmed = process.argv.includes('--yes');
      const migration = await runMigrations(pool);
      if (migration.applied.length > 0) {
        console.log(`Applied ${migration.applied.length} pending migration(s) before restore`);
      }
      const result = await restoreDatabase(pool, resolve(source), { confirmed });
      console.log(`Restored ${result.rows} rows across ${result.tables} tables from ${result.path}`);
    }
  } finally {
    await pool.end();
    if (handle) await handle.stop();
  }
}

function printHelp(): void {
  console.log(`School ERP database CLI

Usage: tsx packages/db/src/cli.ts <command>

Commands:
  migrate   Apply pending SQL migrations
  seed      Insert reference data and the synthetic demo school
  setup     migrate + seed (default first-run command)
  reset     Drop the local public schema, then migrate + seed
  backup    Write a JSON snapshot (optional path argument)
  restore   Restore a JSON snapshot: restore <file> --yes (local only)
`);
}

main()
  .then(() => {
    // Embedded PostgreSQL installs an async exit hook that keeps the event loop
    // alive; exit explicitly once the command has finished.
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nDatabase command failed: ${message}`);
    process.exit(1);
  });
