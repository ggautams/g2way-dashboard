import 'server-only';

import { and, asc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { ROLLUP_COUNTERS, type RollupDelta } from '@/lib/analytics/rollup';
import { TRAFFIC_COUNTERS, type TrafficBucket } from '@/lib/analytics/traffic';
import type { RollupBucketSeconds } from './schema/shared';
import type * as sqliteSchema from './schema/sqlite';
import type { DataHandle } from './users';

/**
 * Analytics rollups and the ingest worker's state (ADR-0012). Every function
 * takes the org explicitly (`getOrgId()` at the call site) and scopes every
 * statement to it (ADR-0007).
 *
 * Writes are additive upserts, so several workers draining the same list
 * (replicas, or the server plus `npm run ingest`) never lose each other's
 * counts. Nothing here is audited: ingest is not a person's action.
 */

export type AnalyticsRollup = typeof sqliteSchema.analyticsRollups.$inferSelect;
export type AnalyticsIngestState = typeof sqliteSchema.analyticsIngestState.$inferSelect;

/** What one drained batch adds to the ingest state. */
export type IngestBatch = {
  environment: string;
  deltas: readonly RollupDelta[];
  /** Records folded into `deltas`. */
  ingested: number;
  /** Elements dropped as malformed or foreign. */
  rejected: number;
  /** Why the last dropped element was dropped, if any was. */
  lastRejection: string | null;
  /** The newest record timestamp in the batch, if any record parsed. */
  lastRecordAt: Date | null;
  /** The list's length right after the pop. */
  backlog: number;
  drainedAt: Date;
};

/** Rows per multi-row insert: 36 columns × 200 stays far below every driver's parameter limit. */
const CHUNK = 200;

type Column = AnySQLiteColumn | AnyPgColumn;

/** `excluded.<column>`: the value the conflicting insert proposed. */
function excluded(column: Column): SQL {
  return sql`excluded.${sql.identifier(column.name)}`;
}

/** The dialect's two-argument maximum (SQLite's scalar `max`, Postgres' `greatest`). */
function larger(dialect: DataHandle['dialect'], a: SQL | Column, b: SQL | Column): SQL {
  return dialect === 'sqlite' ? sql`max(${a}, ${b})` : sql`greatest(${a}, ${b})`;
}

type RollupTable = typeof sqliteSchema.analyticsRollups;
type StateTable = typeof sqliteSchema.analyticsIngestState;

/** The upsert's `SET`: counters add, the max merges, a label is replaced only by a newer one. */
function rollupSet(dialect: DataHandle['dialect'], t: RollupTable | PgRollupTable) {
  const set: Record<string, SQL> = {};
  const columns = t as unknown as Record<string, Column>;
  for (const name of ROLLUP_COUNTERS) {
    set[name] = sql`${columns[name]} + ${excluded(columns[name])}`;
  }
  set.latencyMaxMs = larger(dialect, t.latencyMaxMs, excluded(t.latencyMaxMs));
  set.label = sql`coalesce(${excluded(t.label)}, ${t.label})`;
  return set;
}

function stateSet(dialect: DataHandle['dialect'], t: StateTable | PgStateTable) {
  const coalesced = (column: Column) => ({
    mine: sql`coalesce(${column}, ${excluded(column)})`,
    theirs: sql`coalesce(${excluded(column)}, ${column})`,
  });
  const lastRecord = coalesced(t.lastRecordAt);
  return {
    recordsIngested: sql`${t.recordsIngested} + ${excluded(t.recordsIngested)}`,
    recordsRejected: sql`${t.recordsRejected} + ${excluded(t.recordsRejected)}`,
    batches: sql`${t.batches} + ${excluded(t.batches)}`,
    backlog: excluded(t.backlog),
    lastDrainedAt: excluded(t.lastDrainedAt),
    lastPolledAt: excluded(t.lastPolledAt),
    // Newest wins; SQLite's max() would turn one NULL into NULL, hence coalesce.
    lastRecordAt: larger(dialect, lastRecord.mine, lastRecord.theirs),
    lastRejection: sql`coalesce(${excluded(t.lastRejection)}, ${t.lastRejection})`,
    updatedAt: excluded(t.updatedAt),
  };
}

type PgHandle = Extract<DataHandle, { dialect: 'postgres' }>;
type PgRollupTable = PgHandle['schema']['analyticsRollups'];
type PgStateTable = PgHandle['schema']['analyticsIngestState'];

/**
 * Adds one batch's rollup deltas and counters in a single transaction: either
 * the whole batch lands or none of it does, so the worker can retry it as is.
 */
export async function writeIngestBatch(
  handle: DataHandle,
  orgId: string,
  batch: IngestBatch,
): Promise<void> {
  const { environment } = batch;
  const rows = batch.deltas.map((delta) => ({ ...delta, orgId, environment }));
  const state = {
    orgId,
    environment,
    recordsIngested: batch.ingested,
    recordsRejected: batch.rejected,
    batches: 1,
    backlog: batch.backlog,
    lastDrainedAt: batch.drainedAt,
    // A drain is a poll too: the heartbeat moves with every batch.
    lastPolledAt: batch.drainedAt,
    lastRecordAt: batch.lastRecordAt,
    lastRejection: batch.lastRejection,
    updatedAt: batch.drainedAt,
  };

  if (handle.dialect === 'sqlite') {
    const { db, schema } = handle;
    const t = schema.analyticsRollups;
    const s = schema.analyticsIngestState;
    const target = [
      t.orgId,
      t.environment,
      t.bucketSeconds,
      t.bucketStart,
      t.apiId,
      t.dimension,
      t.value,
    ];
    db.transaction(
      (tx) => {
        for (let i = 0; i < rows.length; i += CHUNK) {
          tx.insert(t)
            .values(rows.slice(i, i + CHUNK))
            .onConflictDoUpdate({ target, set: rollupSet('sqlite', t) })
            .run();
        }
        tx.insert(s)
          .values(state)
          .onConflictDoUpdate({ target: [s.orgId, s.environment], set: stateSet('sqlite', s) })
          .run();
      },
      { behavior: 'immediate' },
    );
    return;
  }
  const { db, schema } = handle;
  const t = schema.analyticsRollups;
  const s = schema.analyticsIngestState;
  const target = [
    t.orgId,
    t.environment,
    t.bucketSeconds,
    t.bucketStart,
    t.apiId,
    t.dimension,
    t.value,
  ];
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx
        .insert(t)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({ target, set: rollupSet('postgres', t) });
    }
    await tx
      .insert(s)
      .values(state)
      .onConflictDoUpdate({ target: [s.orgId, s.environment], set: stateSet('postgres', s) });
  });
}

/**
 * Records a Redis or database failure on the environment's ingest state. The
 * message is the caller's, already stripped of anything secret (a Redis URL
 * carries a password). Best effort by nature: when the database itself is the
 * failure, this fails too, and the worker only logs.
 */
export async function recordIngestError(
  handle: DataHandle,
  orgId: string,
  environment: string,
  message: string,
  at: Date,
): Promise<void> {
  const values = { orgId, environment, lastError: message, lastErrorAt: at, updatedAt: at };
  const set = { lastError: message, lastErrorAt: at, updatedAt: at };
  if (handle.dialect === 'sqlite') {
    const s = handle.schema.analyticsIngestState;
    handle.db
      .insert(s)
      .values(values)
      .onConflictDoUpdate({ target: [s.orgId, s.environment], set })
      .run();
    return;
  }
  const s = handle.schema.analyticsIngestState;
  await handle.db
    .insert(s)
    .values(values)
    .onConflictDoUpdate({ target: [s.orgId, s.environment], set });
}

/**
 * The worker's heartbeat (ADR-0012 §8): a pop succeeded and found the list
 * empty, so the backlog is 0 as of `at`. Counters and `last_drained_at` are
 * untouched; the row is created if this is the environment's first report.
 */
export async function recordIngestHeartbeat(
  handle: DataHandle,
  orgId: string,
  environment: string,
  at: Date,
): Promise<void> {
  const set = { lastPolledAt: at, backlog: 0, updatedAt: at };
  const values = { orgId, environment, ...set };
  if (handle.dialect === 'sqlite') {
    const s = handle.schema.analyticsIngestState;
    handle.db
      .insert(s)
      .values(values)
      .onConflictDoUpdate({ target: [s.orgId, s.environment], set })
      .run();
    return;
  }
  const s = handle.schema.analyticsIngestState;
  await handle.db
    .insert(s)
    .values(values)
    .onConflictDoUpdate({ target: [s.orgId, s.environment], set });
}

/** The environment's ingest state, or `undefined` when no worker ever reported. */
export async function getIngestState(
  handle: DataHandle,
  orgId: string,
  environment: string,
): Promise<AnalyticsIngestState | undefined> {
  if (handle.dialect === 'sqlite') {
    const s = handle.schema.analyticsIngestState;
    return handle.db
      .select()
      .from(s)
      .where(and(eq(s.orgId, orgId), eq(s.environment, environment)))
      .get();
  }
  const s = handle.schema.analyticsIngestState;
  const [row] = await handle.db
    .select()
    .from(s)
    .where(and(eq(s.orgId, orgId), eq(s.environment, environment)));
  return row;
}

/** Retention cut-offs: rows whose bucket starts before these are deleted. */
export type PruneCutoffs = { minuteBefore: Date; hourBefore: Date };

/**
 * Deletes the org's minute and hour rollups older than their cut-offs, in every
 * environment (ADR-0012 §7).
 */
export async function pruneRollups(
  handle: DataHandle,
  orgId: string,
  cutoffs: PruneCutoffs,
): Promise<void> {
  const plan = [
    [60, cutoffs.minuteBefore],
    [3600, cutoffs.hourBefore],
  ] as const;
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.analyticsRollups;
    for (const [seconds, before] of plan) {
      handle.db
        .delete(t)
        .where(and(eq(t.orgId, orgId), eq(t.bucketSeconds, seconds), lt(t.bucketStart, before)))
        .run();
    }
    return;
  }
  const t = handle.schema.analyticsRollups;
  for (const [seconds, before] of plan) {
    await handle.db
      .delete(t)
      .where(and(eq(t.orgId, orgId), eq(t.bucketSeconds, seconds), lt(t.bucketStart, before)));
  }
}

/** Which rollups `queryTrafficBuckets` sums. */
export type TrafficQuery = {
  environment: string;
  bucketSeconds: RollupBucketSeconds;
  /** Inclusive lower bound on `bucket_start` (Unix ms). */
  from: number;
  /** Exclusive upper bound on `bucket_start` (Unix ms). */
  to: number;
  /** One API's traffic; every API's when omitted. */
  apiId?: string;
};

/**
 * Per-bucket traffic totals from the `api` dimension rows (value `''`, each
 * API's total), summed across APIs unless `apiId` narrows it, oldest first.
 * Buckets without traffic have no row and are absent: `resample` gap-fills.
 */
export async function queryTrafficBuckets(
  handle: DataHandle,
  orgId: string,
  query: TrafficQuery,
): Promise<TrafficBucket[]> {
  const aggregates = (t: RollupTable | PgRollupTable) => {
    const columns = t as unknown as Record<string, Column>;
    const sums = Object.fromEntries(
      TRAFFIC_COUNTERS.map((name) => [
        name,
        // Postgres sums bigint to numeric, which its driver returns as a string.
        sql<number>`coalesce(sum(${columns[name]}), 0)`.mapWith(Number),
      ]),
    ) as Record<(typeof TRAFFIC_COUNTERS)[number], SQL<number>>;
    return {
      latencyMaxMs: sql<number>`coalesce(max(${t.latencyMaxMs}), 0)`.mapWith(Number),
      ...sums,
    };
  };
  const where = (t: RollupTable | PgRollupTable) =>
    and(
      eq(t.orgId, orgId),
      eq(t.environment, query.environment),
      eq(t.bucketSeconds, query.bucketSeconds),
      eq(t.dimension, 'api'),
      eq(t.value, ''),
      gte(t.bucketStart, new Date(query.from)),
      lt(t.bucketStart, new Date(query.to)),
      query.apiId === undefined ? undefined : eq(t.apiId, query.apiId),
    );

  let rows: ({ bucketStart: Date } & Omit<TrafficBucket, 'start'>)[];
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.analyticsRollups;
    rows = handle.db
      .select({ bucketStart: t.bucketStart, ...aggregates(t) })
      .from(t)
      .where(where(t))
      .groupBy(t.bucketStart)
      .orderBy(asc(t.bucketStart))
      .all();
  } else {
    const t = handle.schema.analyticsRollups;
    rows = await handle.db
      .select({ bucketStart: t.bucketStart, ...aggregates(t) })
      .from(t)
      .where(where(t))
      .groupBy(t.bucketStart)
      .orderBy(asc(t.bucketStart));
  }
  return rows.map(({ bucketStart, ...counters }) => ({
    ...counters,
    start: bucketStart.getTime(),
  }));
}
