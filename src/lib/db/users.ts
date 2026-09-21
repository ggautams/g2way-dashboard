import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as pgSchema from './schema/pg';
import type { Role } from './schema/shared';
import type * as sqliteSchema from './schema/sqlite';

/**
 * Data access for dashboard accounts. The one place that narrows the database
 * union on `dialect` for users (ADR-0003 §6), so pages, route handlers and the
 * auth layer call plain async functions and never see a dialect.
 *
 * Every function takes the org explicitly: the caller supplies it from config
 * (`getOrgId()`), never a literal.
 */

/**
 * What a data-access function needs from a database handle. `DashboardDatabase`
 * satisfies it; so does a PGlite handle in tests, since only the Postgres query
 * builder matters here, not which driver sits under it.
 */
export type DataHandle =
  | {
      dialect: 'sqlite';
      db: BetterSQLite3Database<typeof sqliteSchema>;
      schema: typeof sqliteSchema;
    }
  | {
      dialect: 'postgres';
      db: PgDatabase<PgQueryResultHKT, typeof pgSchema>;
      schema: typeof pgSchema;
    };

/** A user row. Both dialects read back as this type (`schema.test.ts`). */
export type User = typeof sqliteSchema.users.$inferSelect;

/** Emails are stored and matched trimmed and lower-cased (the unique index is per org). */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hasUsers(handle: DataHandle, orgId: string): Promise<boolean> {
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const row = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.orgId, orgId))
      .limit(1)
      .get();
    return row !== undefined;
  }
  const { db, schema } = handle;
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.orgId, orgId))
    .limit(1);
  return rows.length > 0;
}

export async function findUserByEmail(
  handle: DataHandle,
  orgId: string,
  email: string,
): Promise<User | undefined> {
  const address = normaliseEmail(email);
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    return db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), eq(schema.users.email, address)))
      .get();
  }
  const { db, schema } = handle;
  const [row] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.orgId, orgId), eq(schema.users.email, address)));
  return row;
}

export async function findUserById(
  handle: DataHandle,
  orgId: string,
  id: string,
): Promise<User | undefined> {
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    return db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), eq(schema.users.id, id)))
      .get();
  }
  const { db, schema } = handle;
  const [row] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.orgId, orgId), eq(schema.users.id, id)));
  return row;
}

export type NewUser = {
  email: string;
  name: string;
  /** From `hashPassword()`; never a plain password. */
  passwordHash: string;
};

/**
 * First-run bootstrap: creates `user` as the org's owner **only if the org has
 * no users yet**, and returns it; returns `null` when someone got there first.
 *
 * Race-safe: the emptiness check and the insert run in one transaction that
 * holds a write lock from its start — SQLite's `BEGIN IMMEDIATE`, and on
 * Postgres a transaction-scoped advisory lock keyed on the org — so two
 * concurrent submits yield exactly one owner. (A plain read-committed
 * transaction would let both see an empty table, and the emails differ, so the
 * unique index would not save us.)
 */
export async function createFirstOwner(
  handle: DataHandle,
  orgId: string,
  user: NewUser,
): Promise<User | null> {
  const values = {
    orgId,
    email: normaliseEmail(user.email),
    name: user.name.trim(),
    passwordHash: user.passwordHash,
    role: 'owner' as const satisfies Role,
  };

  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    // better-sqlite3 transactions are synchronous: no await may appear inside.
    return db.transaction(
      (tx) => {
        const existing = tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.orgId, orgId))
          .limit(1)
          .get();
        if (existing !== undefined) return null;
        return tx.insert(schema.users).values(values).returning().get();
      },
      { behavior: 'immediate' },
    );
  }

  const { db, schema } = handle;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`g2dash:bootstrap:${orgId}`}))`);
    const existing = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.orgId, orgId))
      .limit(1);
    if (existing.length > 0) return null;
    const [created] = await tx.insert(schema.users).values(values).returning();
    return created;
  });
}
