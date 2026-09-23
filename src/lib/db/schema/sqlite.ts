import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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

/**
 * Dashboard accounts. `email` is unique per org and stored lower-cased by the
 * caller. `password_changed_at` is set by a password change or reset; sessions
 * signed in before it are no longer honoured (ADR-0004 §9).
 */
export const users = sqliteTable(
  'users',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: integer('password_changed_at', { mode: 'timestamp_ms' }),
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

/**
 * Every version of a gateway API definition or policy written through the
 * dashboard, per environment (ADR-0008). Unlike `audit_log`, `definition` is
 * stored **unredacted** — a rollback must restore secrets too — so this table
 * is as sensitive as the gateway's own storage. `definition` is null for a
 * delete. `audit_id` links the audit row of the write that produced it.
 */
export const configVersions = sqliteTable(
  'config_versions',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    environment: text('environment').notNull(),
    kind: text('kind', { enum: CONFIG_KINDS }).notNull(),
    resourceId: text('resource_id').notNull(),
    action: text('action', { enum: VERSION_ACTIONS }).notNull(),
    definition: text('definition', { mode: 'json' }).$type<JsonValue>(),
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

/**
 * The dashboard's own inventory of gateway keys (ADR-0009 §7). g2way lists keys
 * by hash only and has nowhere to put a human label, so the label, owner and
 * notes live here, one row per key per environment, keyed by the gateway's
 * `key_hash` (never the raw key). `owner` is free text: a key's owner is
 * usually a consumer (a team, a customer, a service), not a dashboard account.
 * `created_by` is the email of the account that first wrote the row,
 * snapshotted like the audit log's actor. The row is removed when the key is
 * hard-deleted through the dashboard and carried to the new hash on rotate.
 */
export const keyMetadata = sqliteTable(
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

/** A traffic counter: SQLite's `integer` is 64-bit. Postgres uses `bigint`. */
const counter = (name: string) => integer(name).notNull().default(0);

/**
 * Traffic rollups drained from the gateway's analytics record list (ADR-0012).
 * One row per bucket (`bucket_seconds` 60 or 3600, `bucket_start` its first
 * instant), API and one `dimension`/`value` pair: `api`/`''` is the API's
 * total, the others break it down by key hash (`''` for none), method, exact
 * status code or path (`(other)` past the per-batch path cap). Every measure is
 * additive, so wider questions are sums; `latency_max_ms` merges with max.
 * `label` is the latest `key_alias` seen, on `key` rows only. The latency
 * histogram's `latency_le_<ms>` columns are non-cumulative bucket counts
 * (bounds in `LATENCY_BOUNDS_MS`), `latency_over` the rest.
 */
export const analyticsRollups = sqliteTable(
  'analytics_rollups',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    environment: text('environment').notNull(),
    bucketSeconds: integer('bucket_seconds').notNull(),
    bucketStart: integer('bucket_start', { mode: 'timestamp_ms' }).notNull(),
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

/**
 * The ingest worker's health, one row per org and environment (ADR-0012 §8):
 * lifetime counters, when records last arrived, the list's length after the
 * last drain (`backlog`) and the last failure. `last_rejection` is why the
 * last malformed record was dropped, never the record itself. `last_polled_at`
 * is the worker's heartbeat: the last successful pop, empty ones included,
 * written at most every `HEARTBEAT_MS` while idle (ADR-0012 §8).
 */
export const analyticsIngestState = sqliteTable(
  'analytics_ingest_state',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    environment: text('environment').notNull(),
    recordsIngested: counter('records_ingested'),
    recordsRejected: counter('records_rejected'),
    batches: counter('batches'),
    backlog: counter('backlog'),
    lastDrainedAt: integer('last_drained_at', { mode: 'timestamp_ms' }),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp_ms' }),
    lastRecordAt: integer('last_record_at', { mode: 'timestamp_ms' }),
    lastRejection: text('last_rejection'),
    lastError: text('last_error'),
    lastErrorAt: integer('last_error_at', { mode: 'timestamp_ms' }),
    updatedAt: timestamp('updated_at').$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('analytics_ingest_state_env_unique').on(t.orgId, t.environment)],
);

/**
 * The live request inspector's tail (ADR-0014): the newest requests the ingest
 * worker popped, per org and environment, written in the same transaction as
 * the batch's rollups and pruned to `G2_ANALYTICS_TAIL_ROWS` rows and 15
 * minutes. A projection of the gateway's record, not a copy: client IP and
 * User-Agent are never stored (ADR-0012 §6). `path` is the raw path as the
 * client sent it (g2way records no query string), `path_template` the value
 * the rollups filed it under (ADR-0012 §5). `at` is the gateway's timestamp.
 */
export const analyticsTail = sqliteTable(
  'analytics_tail',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    environment: text('environment').notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    apiId: text('api_id').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    pathTemplate: text('path_template').notNull(),
    status: integer('status').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    upstreamLatencyMs: integer('upstream_latency_ms'),
    keyHash: text('key_hash'),
    keyAlias: text('key_alias'),
    requestBytes: integer('request_bytes'),
    responseBytes: integer('response_bytes'),
  },
  (t) => [index('analytics_tail_env_at_idx').on(t.orgId, t.environment, t.at)],
);

/**
 * Saved `/analytics` views (ADR-0016): a name for the canonical query string
 * of a view (`drillParams`), in the environment it was saved in. `shared`
 * views are listed for everyone with `gateway:read`; the others only for
 * `owner_id`. `owner_email` is a snapshot, like the audit actor.
 */
export const savedViews = sqliteTable(
  'saved_views',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    environment: text('environment').notNull(),
    ownerId: text('owner_id').notNull(),
    ownerEmail: text('owner_email').notNull(),
    name: text('name').notNull(),
    shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
    query: text('query').notNull(),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at').$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('saved_views_owner_name_unique').on(t.orgId, t.environment, t.ownerId, t.name),
    index('saved_views_env_shared_idx').on(t.orgId, t.environment, t.shared),
  ],
);
