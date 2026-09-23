import 'server-only';

import { and, asc, desc, eq, gte, inArray, like, lt, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { BreakdownGroup, StatusClass } from '@/lib/analytics/drill';
import { ROLLUP_COUNTERS, type RollupDelta } from '@/lib/analytics/rollup';
import { TRAFFIC_COUNTERS, type TrafficBucket } from '@/lib/analytics/traffic';
import type { RollupBucketSeconds, RollupDimension } from './schema/shared';
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

/**
 * Which rollup rows a traffic query sums (ADR-0012 §5). Rows of one
 * `dimension` only: every dimension's rows sum to the same totals, so the
 * default, the `api` rows (value `''`), is the plain total. A drill-down
 * narrows to one value of a dimension, or, for `status`, to one class.
 * Combinations of two dimensions other than the API (key × path) are not
 * stored, so a selection names at most one.
 */
export type RollupSelection = {
  environment: string;
  bucketSeconds: RollupBucketSeconds;
  /** Inclusive lower bound on `bucket_start` (Unix ms). */
  from: number;
  /** Exclusive upper bound on `bucket_start` (Unix ms). */
  to: number;
  /** One API's traffic; every API's when omitted. */
  apiId?: string;
  /** The rows read; `api` when omitted. */
  dimension?: RollupDimension;
  /** Only rows with this exact value (`''` is the keyless `key` row). */
  value?: string;
  /** `status` rows of one class only: 5 reads every `5xx` code. */
  statusClass?: StatusClass;
};

type Rollups = RollupTable | PgRollupTable;

function aggregates(t: Rollups) {
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
}

function selectionWhere(t: Rollups, orgId: string, query: RollupSelection): SQL | undefined {
  const dimension = query.dimension ?? 'api';
  if (query.statusClass !== undefined && dimension !== 'status') {
    throw new Error('statusClass selects status rows only');
  }
  return and(
    eq(t.orgId, orgId),
    eq(t.environment, query.environment),
    eq(t.bucketSeconds, query.bucketSeconds),
    eq(t.dimension, dimension),
    dimension === 'api' ? eq(t.value, '') : undefined,
    query.value === undefined ? undefined : eq(t.value, query.value),
    query.statusClass === undefined ? undefined : like(t.value, `${query.statusClass}%`),
    gte(t.bucketStart, new Date(query.from)),
    lt(t.bucketStart, new Date(query.to)),
    query.apiId === undefined ? undefined : eq(t.apiId, query.apiId),
  );
}

/** The grouping expression. Literal text only, so Postgres sees one expression in SELECT and GROUP BY. */
function groupExpression(t: Rollups, group: BreakdownGroup): SQL<string> {
  switch (group) {
    case 'value':
      return sql<string>`${t.value}`;
    case 'api':
      return sql<string>`${t.apiId}`;
    case 'class':
      return sql<string>`substr(${t.value}, 1, 1)`;
  }
}

type BucketRow = { bucketStart: Date } & Omit<TrafficBucket, 'start'>;

function toBucket({ bucketStart, ...counters }: BucketRow): TrafficBucket {
  return { ...counters, start: bucketStart.getTime() };
}

/**
 * Per-bucket traffic totals of the selected rows, summed across APIs unless
 * `apiId` narrows it, oldest first. Buckets without traffic have no row and
 * are absent: `resample` gap-fills.
 */
export async function queryTrafficBuckets(
  handle: DataHandle,
  orgId: string,
  query: RollupSelection,
): Promise<TrafficBucket[]> {
  let rows: BucketRow[];
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.analyticsRollups;
    rows = handle.db
      .select({ bucketStart: t.bucketStart, ...aggregates(t) })
      .from(t)
      .where(selectionWhere(t, orgId, query))
      .groupBy(t.bucketStart)
      .orderBy(asc(t.bucketStart))
      .all();
  } else {
    const t = handle.schema.analyticsRollups;
    rows = await handle.db
      .select({ bucketStart: t.bucketStart, ...aggregates(t) })
      .from(t)
      .where(selectionWhere(t, orgId, query))
      .groupBy(t.bucketStart)
      .orderBy(asc(t.bucketStart));
  }
  return rows.map(toBucket);
}

/** One group of a breakdown: its totals over the whole window. */
export type BreakdownRow = Omit<TrafficBucket, 'start'> & {
  /** The group: a value, an API id, or a status class digit (`'5'`). */
  group: string;
  /**
   * The `key` rows' alias (`key_alias`), when any bucket recorded one. With
   * several aliases over the window, one of them (the greatest), not
   * necessarily the latest.
   */
  label: string | null;
};

export type BreakdownQuery = RollupSelection & {
  group: BreakdownGroup;
  /** The busiest groups returned, by requests. */
  limit: number;
};

/**
 * The busiest groups of the selected rows over the window, most requests
 * first (ties by group, so the order is stable). The groups not returned are
 * the total (`queryTrafficBuckets` over the same selection) minus these.
 */
export async function queryBreakdown(
  handle: DataHandle,
  orgId: string,
  query: BreakdownQuery,
): Promise<BreakdownRow[]> {
  type Row = Omit<BreakdownRow, 'label'> & { label: string | null };
  let rows: Row[];
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.analyticsRollups;
    const group = groupExpression(t, query.group);
    const requests = sql<number>`sum(${t.requests})`;
    rows = handle.db
      .select({ group, label: sql<string | null>`max(${t.label})`, ...aggregates(t) })
      .from(t)
      .where(selectionWhere(t, orgId, query))
      .groupBy(group)
      .orderBy(desc(requests), asc(group))
      .limit(query.limit)
      .all();
  } else {
    const t = handle.schema.analyticsRollups;
    const group = groupExpression(t, query.group);
    const requests = sql<number>`sum(${t.requests})`;
    rows = await handle.db
      .select({ group, label: sql<string | null>`max(${t.label})`, ...aggregates(t) })
      .from(t)
      .where(selectionWhere(t, orgId, query))
      .groupBy(group)
      .orderBy(desc(requests), asc(group))
      .limit(query.limit);
  }
  return rows.map((row) => ({ ...row, group: String(row.group) }));
}

/**
 * Per-bucket totals of the selected rows for each of `groups`, oldest first:
 * the lines of a breakdown chart. Groups without traffic are absent.
 */
export async function queryBreakdownBuckets(
  handle: DataHandle,
  orgId: string,
  query: RollupSelection & { group: BreakdownGroup; groups: readonly string[] },
): Promise<Map<string, TrafficBucket[]>> {
  const out = new Map<string, TrafficBucket[]>();
  if (query.groups.length === 0) return out;
  type Row = BucketRow & { group: string };
  let rows: Row[];
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.analyticsRollups;
    const group = groupExpression(t, query.group);
    rows = handle.db
      .select({ group, bucketStart: t.bucketStart, ...aggregates(t) })
      .from(t)
      .where(and(selectionWhere(t, orgId, query), inArray(group, [...query.groups])))
      .groupBy(group, t.bucketStart)
      .orderBy(asc(t.bucketStart))
      .all();
  } else {
    const t = handle.schema.analyticsRollups;
    const group = groupExpression(t, query.group);
    rows = await handle.db
      .select({ group, bucketStart: t.bucketStart, ...aggregates(t) })
      .from(t)
      .where(and(selectionWhere(t, orgId, query), inArray(group, [...query.groups])))
      .groupBy(group, t.bucketStart)
      .orderBy(asc(t.bucketStart));
  }
  for (const { group, ...row } of rows) {
    const key = String(group);
    const list = out.get(key) ?? [];
    list.push(toBucket(row));
    out.set(key, list);
  }
  return out;
}
