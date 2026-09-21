import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { ROLES, type JsonValue } from './shared';

/**
 * The dashboard schema for SQLite (the default database). Mirrors `pg.ts`
 * column for column; `schema.test.ts` enforces it. Every table carries `org_id`,
 * which has no default: the caller always supplies it from config (`G2_ORG_ID`).
 */

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) =>
  integer(name, { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());

/** Dashboard accounts. `email` is unique per org and stored lower-cased by the caller. */
export const users = sqliteTable(
  'users',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at').$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('users_org_email_unique').on(t.orgId, t.email)],
);

/**
 * One row per mutating action. The actor is snapshotted (id and email) rather
 * than foreign-keyed, so the trail survives the user being deleted. `gateway_*`
 * is the resulting gateway call, when there was one.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    actorId: text('actor_id'),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    target: text('target'),
    before: text('before', { mode: 'json' }).$type<JsonValue>(),
    after: text('after', { mode: 'json' }).$type<JsonValue>(),
    gatewayMethod: text('gateway_method'),
    gatewayPath: text('gateway_path'),
    gatewayStatus: integer('gateway_status'),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('audit_log_org_created_idx').on(t.orgId, t.createdAt)],
);
