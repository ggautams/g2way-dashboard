import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateDatabase, openDatabase, type DashboardDatabase } from '@/lib/db';
import * as analyticsDb from '@/lib/db/analytics';
import { getIngestState } from '@/lib/db/analytics';
import { BACKOFF_MS, IDLE_MS, drainOnce, runIngest, type IngestDeps } from './ingest';
import type { RecordQueue } from './queue';
import type { AnalyticsRecord } from './record';

// A write that fails on demand, for the retry paths; the real one otherwise.
const failWrites = { remaining: 0 };
vi.mock('@/lib/db/analytics', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/analytics')>();
  return {
    ...real,
    writeIngestBatch: vi.fn(async (...args: Parameters<typeof real.writeIngestBatch>) => {
      if (failWrites.remaining > 0) {
        failWrites.remaining -= 1;
        throw new Error('database is locked');
      }
      return real.writeIngestBatch(...args);
    }),
  };
});

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';
const T0 = Date.UTC(2026, 8, 23, 10, 15, 30);
const REDIS_URL = 'redis://:hunter2@redis.internal:6379';

class MemoryQueue implements RecordQueue {
  items: string[] = [];
  drains = 0;
  failDrains = 0;
  async drain(max: number) {
    this.drains += 1;
    if (this.failDrains > 0) {
      this.failDrains -= 1;
      throw Object.assign(new Error(`connect ECONNREFUSED ${REDIS_URL}`), {
        code: 'ECONNREFUSED',
      });
    }
    return this.items.splice(0, max);
  }
  async length() {
    return this.items.length;
  }
  async close() {}
}

function record(overrides: Partial<AnalyticsRecord> = {}): string {
  return JSON.stringify({
    timestamp_unix_ms: T0,
    api_id: 'users',
    org_id: ORG,
    method: 'GET',
    path: '/users/1',
    status: 200,
    latency_ms: 12,
    ...overrides,
  });
}

let handle: DashboardDatabase;
beforeEach(async () => {
  handle = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  await migrateDatabase(handle);
  failWrites.remaining = 0;
});
afterEach(async () => {
  await handle.close();
  vi.mocked(analyticsDb.writeIngestBatch).mockClear();
});

const silent = { info: () => {}, warn: () => {} };

function deps(overrides: Partial<IngestDeps> = {}): IngestDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    handle,
    orgId: ORG,
    config: { batchSize: 3, minuteRetentionDays: 3, hourRetentionDays: 90 },
    signal: new AbortController().signal,
    now: () => T0 + 1000,
    sleep: async (ms) => void sleeps.push(ms),
    log: silent,
    sleeps,
    ...overrides,
  };
}

async function apiRequests(): Promise<number> {
  if (handle.dialect !== 'sqlite') throw new Error('sqlite only');
  const t = handle.schema.analyticsRollups;
  const rows = handle.db.select().from(t).orderBy(asc(t.id)).all();
  return rows
    .filter((r) => r.dimension === 'api' && r.bucketSeconds === 60)
    .reduce((total, r) => total + r.requests, 0);
}

describe('drainOnce', () => {
  it('pops one batch, writes its rollups and state, and drops malformed elements', async () => {
    const queue = new MemoryQueue();
    queue.items = [record(), 'not json', record({ org_id: 'elsewhere' }), record()];
    const result = await drainOnce({ environment: 'prod', queue, redisUrl: REDIS_URL }, deps());
    expect(result).toEqual({ kind: 'written', popped: 3 });
    expect(queue.items).toHaveLength(1);
    expect(await apiRequests()).toBe(1);
    expect(await getIngestState(handle, ORG, 'prod')).toMatchObject({
      recordsIngested: 1,
      recordsRejected: 2,
      batches: 1,
      backlog: 1,
      lastRecordAt: new Date(T0),
      lastRejection: 'org_id is not the configured org',
    });
  });

  it('writes nothing for an empty list', async () => {
    const queue = new MemoryQueue();
    const result = await drainOnce({ environment: 'prod', queue, redisUrl: REDIS_URL }, deps());
    expect(result).toEqual({ kind: 'empty' });
    expect(await getIngestState(handle, ORG, 'prod')).toBeUndefined();
  });

  it('records a Redis failure by code, never the URL or its password', async () => {
    const queue = new MemoryQueue();
    queue.failDrains = 1;
    const warnings: string[] = [];
    const result = await drainOnce(
      { environment: 'prod', queue, redisUrl: REDIS_URL },
      deps({ log: { info: () => {}, warn: (line: string) => void warnings.push(line) } }),
    );
    expect(result).toEqual({ kind: 'redis-error', message: 'redis: ECONNREFUSED' });
    const state = await getIngestState(handle, ORG, 'prod');
    expect(state?.lastError).toBe('redis: ECONNREFUSED');
    expect(warnings.join('\n')).not.toContain('hunter2');
  });

  it('retries the same batch after a database failure, popping nothing more', async () => {
    const queue = new MemoryQueue();
    queue.items = [record(), record(), record(), record()];
    failWrites.remaining = 2;
    const d = deps();
    const result = await drainOnce({ environment: 'prod', queue, redisUrl: REDIS_URL }, d);
    expect(result).toEqual({ kind: 'written', popped: 3 });
    expect(queue.drains).toBe(1);
    expect(d.sleeps).toEqual([BACKOFF_MS[0], BACKOFF_MS[1]]);
    expect(await apiRequests()).toBe(3);
    // The failure was noted on the state (the write that recorded it succeeded).
    expect((await getIngestState(handle, ORG, 'prod'))?.lastError).toBe(
      'database: database is locked',
    );
  });

  it('on stop, gives a failing write one more try and then reports the batch lost', async () => {
    const queue = new MemoryQueue();
    queue.items = [record(), record()];
    failWrites.remaining = 5;
    const controller = new AbortController();
    const d = deps({
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    const result = await drainOnce({ environment: 'prod', queue, redisUrl: REDIS_URL }, d);
    expect(result).toEqual({ kind: 'lost', popped: 2 });
    expect(vi.mocked(analyticsDb.writeIngestBatch)).toHaveBeenCalledTimes(2);
  });
});

describe('runIngest', () => {
  it('drains full batches back to back, pauses when caught up, and stops on abort', async () => {
    const queue = new MemoryQueue();
    queue.items = Array.from({ length: 7 }, () => record());
    const controller = new AbortController();
    const sleeps: number[] = [];
    await runIngest(
      [{ environment: 'prod', queue, redisUrl: REDIS_URL }],
      deps({
        signal: controller.signal,
        sleep: async (ms) => {
          sleeps.push(ms);
          controller.abort();
        },
      }),
    );
    // 3 + 3 without pausing, then 1 (not a full batch), then one idle pause.
    expect(queue.drains).toBe(3);
    expect(sleeps).toEqual([IDLE_MS]);
    expect(await apiRequests()).toBe(7);
    expect((await getIngestState(handle, ORG, 'prod'))?.batches).toBe(3);
  });

  it('backs off a failing source without holding up the others', async () => {
    const broken = new MemoryQueue();
    broken.failDrains = 100;
    const healthy = new MemoryQueue();
    healthy.items = [record()];
    const controller = new AbortController();
    let clock = T0;
    let passes = 0;
    await runIngest(
      [
        { environment: 'broken', queue: broken, redisUrl: REDIS_URL },
        { environment: 'healthy', queue: healthy, redisUrl: REDIS_URL },
      ],
      deps({
        signal: controller.signal,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          passes += 1;
          if (passes === 4) controller.abort();
          healthy.items.push(record());
        },
      }),
    );
    // Passes at T0, +2 s, +4 s and +6 s. The broken source fails at T0 (retry
    // after 1 s), at +2 s (after 2 s more), at +4 s (after 5 s more), so the
    // +6 s pass skips it; the healthy one is drained on every pass.
    expect(broken.drains).toBe(3);
    expect(healthy.drains).toBe(4);
    expect((await getIngestState(handle, ORG, 'healthy'))?.recordsIngested).toBe(4);
    expect((await getIngestState(handle, ORG, 'broken'))?.lastError).toBe('redis: ECONNREFUSED');
  });

  it('prunes past retention when it starts', async () => {
    const queue = new MemoryQueue();
    queue.items = [record({ timestamp_unix_ms: T0 - 10 * 86_400_000 })];
    await drainOnce({ environment: 'prod', queue, redisUrl: REDIS_URL }, deps());
    expect(await apiRequests()).toBe(1);
    const controller = new AbortController();
    await runIngest([], deps({ signal: controller.signal, sleep: async () => controller.abort() }));
    expect(await apiRequests()).toBe(0);
  });
});
