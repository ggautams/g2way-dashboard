import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { AUDIT_OUTCOMES, ROLES, THROTTLE_KINDS, monotonicUuid, type JsonValue } from './shared';

/**
 * The dashboard schema for SQLite (the default database). Mirrors `pg.ts`
 * column for column; `schema.test.ts` enforces it. Every table carries `org_id`,
 * which has no default: the caller always supplies it from config (`G2_ORG_ID`).
 */

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => monotonicUuid());
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
 * One row per audited action (ADR-0006). The actor is snapshotted (id, email,
 * role) rather than foreign-keyed, so the trail survives the user being deleted
 * or re-roled. `before`/`after` are the redacted state of the target around the
 * action; `request` is the redacted body that was asked for. `gateway_*` is the
 * resulting gateway call, when there was one, and `environment` the gateway it
 * went to. `outcome` is `pending` only between a gateway write being attempted
 * and its result being recorded: a row left `pending` means that record is
 * incomplete. `error` carries the refusal or the gateway's own message; `note`
 * any caveat about the snapshots (e.g. the before-state could not be read).
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    actorId: text('actor_id'),
    actorEmail: text('actor_email'),
    actorRole: text('actor_role', { enum: ROLES }),
    action: text('action').notNull(),
    target: text('target'),
    before: text('before', { mode: 'json' }).$type<JsonValue>(),
    after: text('after', { mode: 'json' }).$type<JsonValue>(),
    gatewayMethod: text('gateway_method'),
    gatewayPath: text('gateway_path'),
    gatewayStatus: integer('gateway_status'),
    environment: text('environment'),
    request: text('request', { mode: 'json' }).$type<JsonValue>(),
    outcome: text('outcome', { enum: AUDIT_OUTCOMES }).notNull(),
    error: text('error'),
    note: text('note'),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('audit_log_org_created_idx').on(t.orgId, t.createdAt)],
);

/**
 * One row per failed sign-in, per thing it counts against (`kind`: the email
 * tried, or the client address), for sign-in throttling
 * (`src/lib/auth/throttle.ts`). Rows older than the throttle window are pruned
 * as new failures are written; a successful sign-in clears its email's rows.
 * `key` is never a raw non-address input: people paste passwords into the
 * email field, so anything that does not look like an email is stored hashed.
 */
export const loginFailures = sqliteTable(
  'login_failures',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    kind: text('kind', { enum: THROTTLE_KINDS }).notNull(),
    key: text('key').notNull(),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('login_failures_lookup_idx').on(t.orgId, t.kind, t.key, t.createdAt)],
);
