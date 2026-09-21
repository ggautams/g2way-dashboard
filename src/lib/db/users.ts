import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { userChangeDenial } from '@/lib/auth/rbac';
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

/** What the users page may show about an account. Never the password hash. */
export type UserSummary = Pick<User, 'id' | 'email' | 'name' | 'role' | 'disabled' | 'createdAt'>;

/** Every account in the org, oldest first. */
export async function listUsers(handle: DataHandle, orgId: string): Promise<UserSummary[]> {
  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const u = schema.users;
    return db
      .select({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        disabled: u.disabled,
        createdAt: u.createdAt,
      })
      .from(u)
      .where(eq(u.orgId, orgId))
      .orderBy(asc(u.createdAt), asc(u.email))
      .all();
  }
  const { db, schema } = handle;
  const u = schema.users;
  return db
    .select({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      disabled: u.disabled,
      createdAt: u.createdAt,
    })
    .from(u)
    .where(eq(u.orgId, orgId))
    .orderBy(asc(u.createdAt), asc(u.email));
}

/**
 * Why a user-management write was refused. `denied` carries
 * {@link userChangeDenial}'s reason; the rest are this layer's own.
 */
export type UserWriteRefusal =
  | { ok: false; reason: 'denied'; message: string }
  | { ok: false; reason: 'not-found'; message: string }
  | { ok: false; reason: 'email-taken'; message: string }
  | { ok: false; reason: 'last-owner'; message: string };

/**
 * A successful write, with the account before and after it — the snapshot the
 * audit log (next task) records. `before` is `null` for a created account.
 */
export type UserWriteResult =
  { ok: true; before: UserSummary | null; after: UserSummary } | UserWriteRefusal;

/** A change to an existing account: a new role, or enabling/disabling it. */
export type UserChange = { role: Role } | { disabled: boolean };

type Actor = { id: string; role: Role; disabled: boolean };

const summarise = ({ id, email, name, role, disabled, createdAt }: User): UserSummary => ({
  id,
  email,
  name,
  role,
  disabled,
  createdAt,
});

/** The invariant: the org always keeps at least one active owner. */
export function removesLastActiveOwner(
  target: Pick<User, 'role' | 'disabled'>,
  change: UserChange,
  activeOwners: number,
): boolean {
  if (target.role !== 'owner' || target.disabled) return false;
  const staysActiveOwner = 'role' in change ? change.role === 'owner' : !change.disabled;
  return !staysActiveOwner && activeOwners <= 1;
}

/**
 * The checks every user-management write makes, in one place for both
 * dialects. Runs inside the write-locked transaction, over rows read inside it.
 */
function decide(
  actor: Actor | undefined,
  target: User | undefined | null,
  /** The role being granted; `undefined` keeps the target's (enable/disable). */
  nextRole: Role | undefined,
): UserWriteRefusal | null {
  if (actor === undefined || actor.disabled) {
    return { ok: false, reason: 'denied', message: 'your account is no longer active' };
  }
  if (target === undefined) return { ok: false, reason: 'not-found', message: 'no such user' };
  const role = nextRole ?? target?.role;
  if (role === undefined) throw new TypeError('a new account needs a role');
  const denial = userChangeDenial(actor, target, role);
  return denial === null ? null : { ok: false, reason: 'denied', message: denial };
}

const LAST_OWNER: UserWriteRefusal = {
  ok: false,
  reason: 'last-owner',
  message: 'this is the last active owner; make someone else an owner first',
};

function usersLockKey(orgId: string): string {
  return `g2dash:users:${orgId}`;
}

/**
 * Creates an account on behalf of `actorId`. The actor is re-read inside the
 * transaction, so a user demoted or disabled a moment ago cannot slip one in.
 */
export async function createUser(
  handle: DataHandle,
  orgId: string,
  actorId: string,
  user: NewUser & { role: Role },
): Promise<UserWriteResult> {
  const values = {
    orgId,
    email: normaliseEmail(user.email),
    name: user.name.trim(),
    passwordHash: user.passwordHash,
    role: user.role,
  };
  const taken: UserWriteRefusal = {
    ok: false,
    reason: 'email-taken',
    message: `an account with the email ${values.email} already exists`,
  };

  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const u = schema.users;
    return db.transaction(
      (tx): UserWriteResult => {
        const actor = tx
          .select()
          .from(u)
          .where(and(eq(u.orgId, orgId), eq(u.id, actorId)))
          .get();
        const refusal = decide(actor, null, values.role);
        if (refusal) return refusal;
        const existing = tx
          .select({ id: u.id })
          .from(u)
          .where(and(eq(u.orgId, orgId), eq(u.email, values.email)))
          .get();
        if (existing !== undefined) return taken;
        const created = tx.insert(u).values(values).returning().get();
        return { ok: true, before: null, after: summarise(created) };
      },
      { behavior: 'immediate' },
    );
  }

  const { db, schema } = handle;
  const u = schema.users;
  return db.transaction(async (tx): Promise<UserWriteResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${usersLockKey(orgId)}))`);
    const [actor] = await tx
      .select()
      .from(u)
      .where(and(eq(u.orgId, orgId), eq(u.id, actorId)));
    const refusal = decide(actor, null, values.role);
    if (refusal) return refusal;
    const existing = await tx
      .select({ id: u.id })
      .from(u)
      .where(and(eq(u.orgId, orgId), eq(u.email, values.email)));
    if (existing.length > 0) return taken;
    const [created] = await tx.insert(u).values(values).returning();
    return { ok: true, before: null, after: summarise(created) };
  });
}

/**
 * Changes `targetId`'s role or enabled state on behalf of `actorId`.
 *
 * Race-safe like `createFirstOwner`: every user-management write takes the
 * same write lock (SQLite `BEGIN IMMEDIATE`; a Postgres advisory lock per org),
 * then re-reads the actor, the target and the active-owner count inside it. So
 * two owners demoting each other at once cannot leave the org without one: the
 * second to get the lock finds its actor no longer an owner.
 */
export async function updateUser(
  handle: DataHandle,
  orgId: string,
  actorId: string,
  targetId: string,
  change: UserChange,
): Promise<UserWriteResult> {
  const values = 'role' in change ? { role: change.role } : { disabled: change.disabled };

  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const u = schema.users;
    return db.transaction(
      (tx): UserWriteResult => {
        const byId = (id: string) =>
          tx
            .select()
            .from(u)
            .where(and(eq(u.orgId, orgId), eq(u.id, id)))
            .get();
        const actor = byId(actorId);
        const target = byId(targetId);
        const refusal = decide(actor, target, 'role' in change ? change.role : undefined);
        if (refusal) return refusal;
        const activeOwners = tx
          .select({ id: u.id })
          .from(u)
          .where(and(eq(u.orgId, orgId), eq(u.role, 'owner'), eq(u.disabled, false)))
          .all().length;
        if (removesLastActiveOwner(target!, change, activeOwners)) return LAST_OWNER;
        const updated = tx
          .update(u)
          .set(values)
          .where(and(eq(u.orgId, orgId), eq(u.id, targetId)))
          .returning()
          .get();
        return { ok: true, before: summarise(target!), after: summarise(updated) };
      },
      { behavior: 'immediate' },
    );
  }

  const { db, schema } = handle;
  const u = schema.users;
  return db.transaction(async (tx): Promise<UserWriteResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${usersLockKey(orgId)}))`);
    const byId = async (id: string) =>
      (
        await tx
          .select()
          .from(u)
          .where(and(eq(u.orgId, orgId), eq(u.id, id)))
      )[0];
    const actor = await byId(actorId);
    const target = await byId(targetId);
    const refusal = decide(actor, target, 'role' in change ? change.role : undefined);
    if (refusal) return refusal;
    const activeOwners = (
      await tx
        .select({ id: u.id })
        .from(u)
        .where(and(eq(u.orgId, orgId), eq(u.role, 'owner'), eq(u.disabled, false)))
    ).length;
    if (removesLastActiveOwner(target!, change, activeOwners)) return LAST_OWNER;
    const [updated] = await tx
      .update(u)
      .set(values)
      .where(and(eq(u.orgId, orgId), eq(u.id, targetId)))
      .returning();
    return { ok: true, before: summarise(target!), after: summarise(updated) };
  });
}
