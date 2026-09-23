import { PGlite } from '@electric-sql/pglite';
import { asc } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { rollupBatch } from '@/lib/analytics/rollup';
import type { AnalyticsRecord } from '@/lib/analytics/record';
import { migrateDatabase, migrationsFolder, openDatabase } from '.';
import {
  getIngestState,
  pruneRollups,
  queryBreakdown,
  queryBreakdownBuckets,
  queryTrafficBuckets,
  recordIngestError,
  recordIngestHeartbeat,
  writeIngestBatch,
  type AnalyticsRollup,
  type IngestBatch,
} from './analytics';
import * as pgSchema from './schema/pg';
import type { DataHandle } from './users';

// Stand-in orgs: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const T0 = Date.UTC(2026, 8, 23, 10, 15, 30);

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function sqliteMemory(): Promise<DataHandle> {
  const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  cleanup.push(() => database.close());
  await migrateDatabase(database);
  return database;
}

async function pglite(): Promise<DataHandle> {
  const client = new PGlite();
  cleanup.push(() => client.close());
  const db = drizzlePglite(client, { schema: pgSchema });
  await migratePglite(db, { migrationsFolder: migrationsFolder('postgres') });
  return { dialect: 'postgres', db, schema: pgSchema };
}

async function rollups(handle: DataHandle): Promise<AnalyticsRollup[]> {
  if (handle.dialect === 'sqlite') {
    const t = handle.schema.analyticsRollups;
    return handle.db.select().from(t).orderBy(asc(t.id)).all();
  }
  const t = handle.schema.analyticsRollups;
  return handle.db.select().from(t).orderBy(asc(t.id));
}

function record(org: string, overrides: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    timestamp_unix_ms: T0,
    api_id: 'users',
    org_id: org,
    method: 'GET',
    path: '/users/1',
    status: 200,
    latency_ms: 12,
    ...overrides,
  };
}

function batch(records: AnalyticsRecord[], overrides: Partial<IngestBatch> = {}): IngestBatch {
  return {
    environment: 'prod',
    deltas: rollupBatch(records),
    ingested: records.length,
    rejected: 0,
    lastRejection: null,
    lastRecordAt:
      records.length === 0 ? null : new Date(Math.max(...records.map((r) => r.timestamp_unix_ms))),
    backlog: 0,
    drainedAt: new Date(T0 + 1000),
    ...overrides,
  };
}

const apiRow = (rows: AnalyticsRollup[], seconds: number, org = ORG_A) =>
  rows.filter((r) => r.orgId === org && r.bucketSeconds === seconds && r.dimension === 'api');

describe.each([
  ['SQLite (in memory)', sqliteMemory],
  ['Postgres (PGlite)', pglite],
])('analytics rollups on %s', (_name, open) => {
  it('adds a second batch to the same rows: counters sum, max merges, label keeps the newest', async () => {
    const handle = await open();
    await writeIngestBatch(
      handle,
      ORG_A,
      batch([record(ORG_A, { latency_ms: 30, key_hash: 'k1', key_alias: 'first' })]),
    );
    await writeIngestBatch(
      handle,
      ORG_A,
      batch([
        record(ORG_A, { latency_ms: 5, status: 500, key_hash: 'k1' }),
        record(ORG_A, { latency_ms: 7, upstream_latency_ms: 6 }),
      ]),
    );
    const rows = await rollups(handle);
    const [minute] = apiRow(rows, 60);
    expect(apiRow(rows, 60)).toHaveLength(1);
    expect(minute).toMatchObject({
      environment: 'prod',
      bucketStart: new Date(Date.UTC(2026, 8, 23, 10, 15)),
      requests: 3,
      status2xx: 2,
      status5xx: 1,
      latencySumMs: 42,
      latencyMaxMs: 30,
      upstreamRequests: 1,
      upstreamLatencySumMs: 6,
      latencyLe5: 1,
      latencyLe10: 1,
      latencyLe50: 1,
    });
    expect(apiRow(rows, 3600)[0].requests).toBe(3);
    const key = rows.filter((r) => r.bucketSeconds === 60 && r.dimension === 'key');
    // The alias survives a batch that did not carry one.
    expect(key.find((r) => r.value === 'k1')).toMatchObject({ requests: 2, label: 'first' });
    expect(key.find((r) => r.value === '')).toMatchObject({ requests: 1, label: null });
  });

  it('sums the API totals per bucket, scoped to org, environment, granularity and window', async () => {
    const handle = await open();
    const minute = Date.UTC(2026, 8, 23, 10, 15);
    await writeIngestBatch(
      handle,
      ORG_A,
      batch([
        record(ORG_A, { latency_ms: 30 }),
        record(ORG_A, { api_id: 'orders', latency_ms: 700, status: 502 }),
        record(ORG_A, { timestamp_unix_ms: T0 + 60_000, status: 404 }),
        // Outside the window queried below.
        record(ORG_A, { timestamp_unix_ms: T0 + 120_000 }),
      ]),
    );
    await writeIngestBatch(handle, ORG_A, batch([record(ORG_A)], { environment: 'staging' }));
    await writeIngestBatch(handle, ORG_B, batch([record(ORG_B)]));

    const window = { environment: 'prod', from: minute, to: minute + 120_000 } as const;
    const buckets = await queryTrafficBuckets(handle, ORG_A, { ...window, bucketSeconds: 60 });
    expect(buckets.map((b) => [b.start, b.requests])).toEqual([
      [minute, 2],
      [minute + 60_000, 1],
    ]);
    expect(buckets[0]).toMatchObject({
      status2xx: 1,
      status5xx: 1,
      latencySumMs: 730,
      latencyMaxMs: 700,
      latencyLe50: 1,
      latencyLe1000: 1,
      latencyOver: 0,
    });
    expect(buckets[1]).toMatchObject({ status4xx: 1 });
    expect(typeof buckets[0].requests).toBe('number');

    const orders = await queryTrafficBuckets(handle, ORG_A, {
      ...window,
      bucketSeconds: 60,
      apiId: 'orders',
    });
    expect(orders.map((b) => b.requests)).toEqual([1]);

    const hour = await queryTrafficBuckets(handle, ORG_A, {
      environment: 'prod',
      bucketSeconds: 3600,
      from: Date.UTC(2026, 8, 23, 10),
      to: Date.UTC(2026, 8, 23, 11),
    });
    expect(hour.map((b) => b.requests)).toEqual([4]);
    expect(await queryTrafficBuckets(handle, ORG_B, { ...window, bucketSeconds: 60 })).toHaveLength(
      1,
    );
  });

  it('drills into one value of one dimension, or one status class', async () => {
    const handle = await open();
    const minute = Date.UTC(2026, 8, 23, 10, 15);
    await writeIngestBatch(
      handle,
      ORG_A,
      batch([
        record(ORG_A, { key_hash: 'k1', status: 503 }),
        record(ORG_A, { key_hash: 'k1', status: 500, method: 'POST' }),
        record(ORG_A, { api_id: 'orders', key_hash: 'k1', status: 200 }),
        record(ORG_A, { api_id: 'orders', status: 404, path: '/orders' }),
      ]),
    );
    await writeIngestBatch(handle, ORG_B, batch([record(ORG_B, { key_hash: 'k1' })]));
    const window = {
      environment: 'prod',
      bucketSeconds: 60,
      from: minute,
      to: minute + 60_000,
    } as const;
    const requests = async (query: Partial<Parameters<typeof queryTrafficBuckets>[2]>) =>
      (await queryTrafficBuckets(handle, ORG_A, { ...window, ...query })).map((b) => b.requests);

    expect(await requests({})).toEqual([4]);
    expect(await requests({ dimension: 'key', value: 'k1' })).toEqual([3]);
    expect(await requests({ dimension: 'key', value: 'k1', apiId: 'users' })).toEqual([2]);
    expect(await requests({ dimension: 'key', value: '' })).toEqual([1]);
    expect(await requests({ dimension: 'status', statusClass: 5 })).toEqual([2]);
    expect(await requests({ dimension: 'status', value: '404' })).toEqual([1]);
    expect(await requests({ dimension: 'method', value: 'POST' })).toEqual([1]);
    expect(await requests({ dimension: 'path', value: '/orders', apiId: 'orders' })).toEqual([1]);
    // A whole dimension sums to the total.
    expect(await requests({ dimension: 'path' })).toEqual([4]);
    await expect(
      queryTrafficBuckets(handle, ORG_A, { ...window, dimension: 'key', statusClass: 5 }),
    ).rejects.toThrow(/status rows only/);
  });

  it('ranks the busiest groups of a breakdown, and reads their lines', async () => {
    const handle = await open();
    const minute = Date.UTC(2026, 8, 23, 10, 15);
    await writeIngestBatch(
      handle,
      ORG_A,
      batch([
        record(ORG_A, { key_hash: 'k1', key_alias: 'mobile', status: 503 }),
        record(ORG_A, { key_hash: 'k1', status: 500, latency_ms: 90 }),
        record(ORG_A, { key_hash: 'k2', status: 502, timestamp_unix_ms: T0 + 60_000 }),
        record(ORG_A, { api_id: 'orders', key_hash: 'k1', status: 200 }),
        record(ORG_A, { api_id: 'orders', status: 404 }),
      ]),
    );
    await writeIngestBatch(handle, ORG_B, batch([record(ORG_B, { key_hash: 'k9' })]));
    const window = {
      environment: 'prod',
      bucketSeconds: 60,
      from: minute,
      to: minute + 120_000,
    } as const;

    const keys = await queryBreakdown(handle, ORG_A, {
      ...window,
      dimension: 'key',
      group: 'value',
      limit: 10,
    });
    expect(keys.map((r) => [r.group, r.label, r.requests])).toEqual([
      ['k1', 'mobile', 3],
      ['', null, 1],
      ['k2', null, 1],
    ]);
    expect(keys[0]).toMatchObject({ status5xx: 2, status2xx: 1, latencyMaxMs: 90 });
    expect(typeof keys[0].requests).toBe('number');

    const limited = await queryBreakdown(handle, ORG_A, {
      ...window,
      dimension: 'key',
      group: 'value',
      limit: 1,
    });
    expect(limited.map((r) => r.group)).toEqual(['k1']);

    const classes = await queryBreakdown(handle, ORG_A, {
      ...window,
      dimension: 'status',
      group: 'class',
      limit: 10,
    });
    expect(classes.map((r) => [r.group, r.requests])).toEqual([
      ['5', 3],
      ['2', 1],
      ['4', 1],
    ]);

    const codes = await queryBreakdown(handle, ORG_A, {
      ...window,
      dimension: 'status',
      statusClass: 5,
      group: 'value',
      limit: 10,
    });
    expect(codes.map((r) => [r.group, r.requests])).toEqual([
      ['500', 1],
      ['502', 1],
      ['503', 1],
    ]);

    // A key's traffic by API: the key rows, grouped by their API.
    const apis = await queryBreakdown(handle, ORG_A, {
      ...window,
      dimension: 'key',
      value: 'k1',
      group: 'api',
      limit: 10,
    });
    expect(apis.map((r) => [r.group, r.requests])).toEqual([
      ['users', 2],
      ['orders', 1],
    ]);

    const lines = await queryBreakdownBuckets(handle, ORG_A, {
      ...window,
      dimension: 'status',
      group: 'class',
      groups: ['5', '4'],
    });
    expect([...lines.keys()].sort()).toEqual(['4', '5']);
    expect(lines.get('5')?.map((b) => [b.start, b.requests])).toEqual([
      [minute, 2],
      [minute + 60_000, 1],
    ]);
    expect(
      await queryBreakdownBuckets(handle, ORG_A, {
        ...window,
        dimension: 'api',
        group: 'api',
        groups: [],
      }),
    ).toEqual(new Map());
  });

  it('keeps environments and orgs apart', async () => {
    const handle = await open();
    await writeIngestBatch(handle, ORG_A, batch([record(ORG_A)]));
    await writeIngestBatch(handle, ORG_A, batch([record(ORG_A)], { environment: 'staging' }));
    await writeIngestBatch(handle, ORG_B, batch([record(ORG_B)]));
    const rows = await rollups(handle);
    expect(apiRow(rows, 60).map((r) => [r.environment, r.requests])).toEqual([
      ['prod', 1],
      ['staging', 1],
    ]);
    expect(apiRow(rows, 60, ORG_B).map((r) => [r.environment, r.requests])).toEqual([['prod', 1]]);
    expect((await getIngestState(handle, ORG_B, 'staging')) ?? null).toBeNull();
  });

  it('accumulates the ingest state and keeps the newest record time', async () => {
    const handle = await open();
    await writeIngestBatch(
      handle,
      ORG_A,
      batch([record(ORG_A, { timestamp_unix_ms: T0 + 5000 })], {
        rejected: 2,
        lastRejection: 'not JSON',
        backlog: 40,
      }),
    );
    // A later, all-rejected batch: no record time of its own, so the newest stays.
    await writeIngestBatch(
      handle,
      ORG_A,
      batch([], { rejected: 1, lastRecordAt: null, backlog: 0, drainedAt: new Date(T0 + 9000) }),
    );
    const state = await getIngestState(handle, ORG_A, 'prod');
    expect(state).toMatchObject({
      orgId: ORG_A,
      recordsIngested: 1,
      recordsRejected: 3,
      batches: 2,
      backlog: 0,
      lastDrainedAt: new Date(T0 + 9000),
      lastPolledAt: new Date(T0 + 9000),
      lastRecordAt: new Date(T0 + 5000),
      lastRejection: 'not JSON',
      lastError: null,
    });
    await writeIngestBatch(handle, ORG_A, batch([record(ORG_A, { timestamp_unix_ms: T0 + 7000 })]));
    expect((await getIngestState(handle, ORG_A, 'prod'))?.lastRecordAt).toEqual(
      new Date(T0 + 7000),
    );
  });

  it('records an error without touching the counters, creating the row if needed', async () => {
    const handle = await open();
    const at = new Date(T0);
    await recordIngestError(handle, ORG_A, 'prod', 'redis: ECONNREFUSED', at);
    expect(await getIngestState(handle, ORG_A, 'prod')).toMatchObject({
      recordsIngested: 0,
      lastError: 'redis: ECONNREFUSED',
      lastErrorAt: at,
      lastDrainedAt: null,
    });
    await writeIngestBatch(handle, ORG_A, batch([record(ORG_A)]));
    await recordIngestError(handle, ORG_A, 'prod', 'later', new Date(T0 + 1));
    expect(await getIngestState(handle, ORG_A, 'prod')).toMatchObject({
      recordsIngested: 1,
      lastError: 'later',
    });
    expect(await getIngestState(handle, ORG_B, 'prod')).toBeUndefined();
  });

  it('records a heartbeat without touching the counters or the last drain', async () => {
    const handle = await open();
    await recordIngestHeartbeat(handle, ORG_A, 'prod', new Date(T0));
    expect(await getIngestState(handle, ORG_A, 'prod')).toMatchObject({
      recordsIngested: 0,
      batches: 0,
      backlog: 0,
      lastPolledAt: new Date(T0),
      lastDrainedAt: null,
    });
    await writeIngestBatch(handle, ORG_A, batch([record(ORG_A)], { backlog: 7 }));
    await recordIngestHeartbeat(handle, ORG_A, 'prod', new Date(T0 + 5000));
    expect(await getIngestState(handle, ORG_A, 'prod')).toMatchObject({
      recordsIngested: 1,
      batches: 1,
      // The empty pop saw an empty list.
      backlog: 0,
      lastDrainedAt: new Date(T0 + 1000),
      lastPolledAt: new Date(T0 + 5000),
    });
    expect(await getIngestState(handle, ORG_B, 'prod')).toBeUndefined();
  });

  it('prunes each granularity at its own cut-off, and only its own org', async () => {
    const handle = await open();
    const oldT = T0 - 10 * 86_400_000;
    for (const org of [ORG_A, ORG_B]) {
      await writeIngestBatch(
        handle,
        org,
        batch([record(org, { timestamp_unix_ms: oldT }), record(org)]),
      );
    }
    await pruneRollups(handle, ORG_A, {
      minuteBefore: new Date(T0 - 86_400_000),
      hourBefore: new Date(T0 - 30 * 86_400_000),
    });
    const rows = await rollups(handle);
    // Org A: the old minute rows are gone, the old hour rows are still inside retention.
    expect(apiRow(rows, 60).map((r) => r.bucketStart.getTime())).toEqual([
      Date.UTC(2026, 8, 23, 10, 15),
    ]);
    expect(apiRow(rows, 3600)).toHaveLength(2);
    // Org B is untouched.
    expect(apiRow(rows, 60, ORG_B)).toHaveLength(2);
  });

  it('writes a large batch across insert chunks', async () => {
    const handle = await open();
    const records = Array.from({ length: 600 }, (_, i) =>
      record(ORG_A, { api_id: `api-${i % 150}`, key_hash: `k${i}` }),
    );
    await writeIngestBatch(handle, ORG_A, batch(records));
    const rows = await rollups(handle);
    expect(apiRow(rows, 60).reduce((total, r) => total + r.requests, 0)).toBe(600);
    expect(rows.filter((r) => r.dimension === 'key' && r.bucketSeconds === 3600)).toHaveLength(600);
  });
});
