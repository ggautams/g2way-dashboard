import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp as pgTimestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  AUDIT_OUTCOMES,
  CONFIG_KINDS,
  ROLES,
  THROTTLE_KINDS,
  VERSION_ACTIONS,
  monotonicUuid,
  type JsonValue,
} from './shared';

/**
 * The dashboard schema for Postgres. Mirrors `sqlite.ts` column for column;
 * `schema.test.ts` enforces it. Documentation for each table lives there.
 */

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => monotonicUuid());
const timestamp = (name: string) =>
  pgTimestamp(name, { withTimezone: true, mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date());

export const users = pgTable(
  'users',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: pgTimestamp('password_changed_at', { withTimezone: true, mode: 'date' }),
    role: text('role', { enum: ROLES }).notNull(),
    disabled: boolean('disabled').notNull().default(false),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at').$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('users_org_email_unique').on(t.orgId, t.email)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    actorId: text('actor_id'),
    actorEmail: text('actor_email'),
    actorRole: text('actor_role', { enum: ROLES }),
    action: text('action').notNull(),
    target: text('target'),
    before: jsonb('before').$type<JsonValue>(),
    after: jsonb('after').$type<JsonValue>(),
    gatewayMethod: text('gateway_method'),
    gatewayPath: text('gateway_path'),
    gatewayStatus: integer('gateway_status'),
    environment: text('environment'),
    request: jsonb('request').$type<JsonValue>(),
    outcome: text('outcome', { enum: AUDIT_OUTCOMES }).notNull(),
    error: text('error'),
    note: text('note'),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('audit_log_org_created_idx').on(t.orgId, t.createdAt)],
);

export const loginFailures = pgTable(
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

export const configVersions = pgTable(
  'config_versions',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    environment: text('environment').notNull(),
    kind: text('kind', { enum: CONFIG_KINDS }).notNull(),
    resourceId: text('resource_id').notNull(),
    action: text('action', { enum: VERSION_ACTIONS }).notNull(),
    definition: jsonb('definition').$type<JsonValue>(),
    actorId: text('actor_id'),
    actorEmail: text('actor_email'),
    auditId: text('audit_id'),
    createdAt: timestamp('created_at'),
  },
  (t) => [
    index('config_versions_resource_idx').on(
      t.orgId,
      t.environment,
      t.kind,
      t.resourceId,
      t.createdAt,
    ),
  ],
);
