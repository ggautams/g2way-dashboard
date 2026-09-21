import 'server-only';

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { parseDatabaseUrl, type DatabaseConfig } from './config';
import * as pgSchema from './schema/pg';
import * as sqliteSchema from './schema/sqlite';

/**
 * The dashboard's own database: users, audit, history — never the gateway's
 * Redis (ADR-0001). SQLite by default, Postgres when `DATABASE_URL` says so
 * (`config.ts`). Server-only: it holds password hashes and, for Postgres, a
 * connection string with credentials.
 *
 * The handle is a union tagged by `dialect`, each side carrying its own
 * dialect-typed schema (ADR-0003). Data-access code narrows on `dialect`.
 */

export type SqliteDatabase = {
  dialect: 'sqlite';
  db: BetterSQLite3Database<typeof sqliteSchema>;
  schema: typeof sqliteSchema;
  close(): Promise<void>;
};

export type PostgresDatabase = {
  dialect: 'postgres';
  db: NodePgDatabase<typeof pgSchema>;
  schema: typeof pgSchema;
  close(): Promise<void>;
};

export type DashboardDatabase = SqliteDatabase | PostgresDatabase;

/** Where drizzle-kit writes each dialect's migrations (`drizzle.*.config.ts`). */
export function migrationsFolder(dialect: DatabaseConfig['dialect']): string {
  return resolve(process.cwd(), 'drizzle', dialect === 'sqlite' ? 'sqlite' : 'pg');
}

/** Opens a connection. Creates the SQLite file's directory if it is missing. */
export function openDatabase(config: DatabaseConfig): DashboardDatabase {
  if (config.dialect === 'postgres') {
    const pool = new Pool({ connectionString: config.url });
    return {
      dialect: 'postgres',
      db: drizzlePg(pool, { schema: pgSchema }),
      schema: pgSchema,
      close: () => pool.end(),
    };
  }
  if (config.path !== ':memory:') mkdirSync(dirname(resolve(config.path)), { recursive: true });
  const client = new Sqlite(config.path);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
  return {
    dialect: 'sqlite',
    db: drizzleSqlite(client, { schema: sqliteSchema }),
    schema: sqliteSchema,
    close: async () => void client.close(),
  };
}

/** Applies every pending migration for the handle's dialect. Idempotent. */
export async function migrateDatabase(database: DashboardDatabase = getDatabase()): Promise<void> {
  const migrationsFolder_ = migrationsFolder(database.dialect);
  if (database.dialect === 'sqlite')
    migrateSqlite(database.db, { migrationsFolder: migrationsFolder_ });
  else await migratePg(database.db, { migrationsFolder: migrationsFolder_ });
}

// Kept on globalThis so dev-server module reloads reuse one connection.
const holder = globalThis as typeof globalThis & { __g2DashboardDb?: DashboardDatabase };

/** The process-wide database, opened on first use from `DATABASE_URL`. */
export function getDatabase(): DashboardDatabase {
  holder.__g2DashboardDb ??= openDatabase(parseDatabaseUrl(process.env));
  return holder.__g2DashboardDb;
}
