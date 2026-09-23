import {
  bigint,
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
  ROLLUP_DIMENSIONS,
  THROTTLE_KINDS,
  VERSION_ACTIONS,
  latencyColumns,
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

export const keyMetadata = pgTable(
  'key_metadata',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    environment: text('environment').notNull(),
    keyHash: text('key_hash').notNull(),
    label: text('label'),
    owner: text('owner'),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at').$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('key_metadata_key_unique').on(t.orgId, t.environment, t.keyHash)],
);

/** A traffic counter: `bigint` read as a JS number (SQLite's `integer` is 64-bit too). */
const counter = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);
const optionalTimestamp = (name: string) => pgTimestamp(name, { withTimezone: true, mode: 'date' });

export const analyticsRollups = pgTable(
  'analytics_rollups',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    environment: text('environment').notNull(),
    bucketSeconds: integer('bucket_seconds').notNull(),
    bucketStart: pgTimestamp('bucket_start', { withTimezone: true, mode: 'date' }).notNull(),
    apiId: text('api_id').notNull(),
    dimension: text('dimension', { enum: ROLLUP_DIMENSIONS }).notNull(),
    value: text('value').notNull(),
    label: text('label'),
    requests: counter('requests'),
    status1xx: counter('status_1xx'),
    status2xx: counter('status_2xx'),
    status3xx: counter('status_3xx'),
    status4xx: counter('status_4xx'),
    status5xx: counter('status_5xx'),
    latencySumMs: counter('latency_sum_ms'),
    latencyMaxMs: counter('latency_max_ms'),
    upstreamRequests: counter('upstream_requests'),
    upstreamLatencySumMs: counter('upstream_latency_sum_ms'),
    requestBytes: counter('request_bytes'),
    responseBytes: counter('response_bytes'),
    ...latencyColumns(counter),
    latencyOver: counter('latency_over'),
  },
  (t) => [
    uniqueIndex('analytics_rollups_bucket_unique').on(
      t.orgId,
      t.environment,
      t.bucketSeconds,
      t.bucketStart,
      t.apiId,
      t.dimension,
      t.value,
    ),
    index('analytics_rollups_drill_idx').on(
      t.orgId,
      t.environment,
      t.bucketSeconds,
      t.dimension,
      t.apiId,
      t.bucketStart,
    ),
  ],
);

export const analyticsIngestState = pgTable(
  'analytics_ingest_state',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    environment: text('environment').notNull(),
    recordsIngested: counter('records_ingested'),
    recordsRejected: counter('records_rejected'),
    batches: counter('batches'),
    backlog: counter('backlog'),
    lastDrainedAt: optionalTimestamp('last_drained_at'),
    lastRecordAt: optionalTimestamp('last_record_at'),
    lastRejection: text('last_rejection'),
    lastError: text('last_error'),
    lastErrorAt: optionalTimestamp('last_error_at'),
    updatedAt: timestamp('updated_at').$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('analytics_ingest_state_env_unique').on(t.orgId, t.environment)],
);
