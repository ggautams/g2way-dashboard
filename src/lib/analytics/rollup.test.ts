import { describe, expect, it } from 'vitest';
import type { AnalyticsRecord } from './record';
import {
  MAX_PATH_LENGTH,
  MAX_PATHS_PER_BUCKET,
  OTHER_PATHS,
  bucketStartOf,
  latencyBucketOf,
  rollupBatch,
  type RollupDelta,
} from './rollup';

const ORG = 'org-under-test';
// 2026-09-23T10:15:30.000Z
const T0 = Date.UTC(2026, 8, 23, 10, 15, 30);

function record(overrides: Partial<AnalyticsRecord> = {}): AnalyticsRecord {
  return {
    timestamp_unix_ms: T0,
    api_id: 'users',
    org_id: ORG,
    method: 'GET',
    path: '/users/1',
    status: 200,
    latency_ms: 12,
    ...overrides,
  };
}

function find(
  deltas: RollupDelta[],
  bucketSeconds: number,
  dimension: string,
  value: string,
  apiId = 'users',
) {
  return deltas.filter(
    (d) =>
      d.bucketSeconds === bucketSeconds &&
      d.dimension === dimension &&
      d.value === value &&
      d.apiId === apiId,
  );
}

describe('bucketStartOf', () => {
  it('floors to the minute and the hour', () => {
    expect(bucketStartOf(T0, 60).toISOString()).toBe('2026-09-23T10:15:00.000Z');
    expect(bucketStartOf(T0, 3600).toISOString()).toBe('2026-09-23T10:00:00.000Z');
  });
});

describe('latencyBucketOf', () => {
  it.each([
    [0, 'latencyLe1'],
    [1, 'latencyLe1'],
    [2, 'latencyLe2'],
    [3, 'latencyLe5'],
    [10000, 'latencyLe10000'],
    [10001, 'latencyOver'],
  ])('%i ms → %s', (ms, bucket) => {
    expect(latencyBucketOf(ms)).toBe(bucket);
  });
});

describe('rollupBatch', () => {
  it('adds each record to five rows per granularity', () => {
    const deltas = rollupBatch([record({ key_hash: 'k1', key_alias: 'mobile' })]);
    expect(deltas).toHaveLength(10);
    for (const seconds of [60, 3600]) {
      expect(find(deltas, seconds, 'api', '')).toHaveLength(1);
      expect(find(deltas, seconds, 'key', 'k1')[0].label).toBe('mobile');
      expect(find(deltas, seconds, 'method', 'GET')).toHaveLength(1);
      expect(find(deltas, seconds, 'status', '200')).toHaveLength(1);
      expect(find(deltas, seconds, 'path', '/users/1')).toHaveLength(1);
    }
  });

  it('sums measures, keeps the max and fills the histogram', () => {
    const deltas = rollupBatch([
      record({ status: 200, latency_ms: 3, upstream_latency_ms: 2, response_content_length: 10 }),
      record({ status: 503, latency_ms: 40, upstream_latency_ms: 38, request_content_length: 5 }),
      record({ status: 401, latency_ms: 20000 }),
      record({ status: 101, latency_ms: 1 }),
    ]);
    const [api] = find(deltas, 60, 'api', '');
    expect(api).toMatchObject({
      requests: 4,
      status1xx: 1,
      status2xx: 1,
      status3xx: 0,
      status4xx: 1,
      status5xx: 1,
      latencySumMs: 20044,
      latencyMaxMs: 20000,
      upstreamRequests: 2,
      upstreamLatencySumMs: 40,
      requestBytes: 5,
      responseBytes: 10,
      latencyLe1: 1,
      latencyLe5: 1,
      latencyLe50: 1,
      latencyOver: 1,
      label: null,
    });
  });

  it('breaks down within an API so each dimension sums to the API total', () => {
    const records = [
      record({ key_hash: 'k1' }),
      record({ key_hash: 'k2', method: 'POST', status: 500 }),
      record({ path: '/users/2' }),
    ];
    const deltas = rollupBatch(records);
    for (const dimension of ['key', 'method', 'status', 'path']) {
      const sum = deltas
        .filter((d) => d.bucketSeconds === 60 && d.dimension === dimension)
        .reduce((total, d) => total + d.requests, 0);
      expect(sum, dimension).toBe(3);
    }
    // A keyless request is counted under the empty key.
    expect(find(deltas, 60, 'key', '')[0].requests).toBe(1);
  });

  it('keeps APIs and buckets apart', () => {
    const deltas = rollupBatch([
      record(),
      record({ api_id: 'orders' }),
      record({ timestamp_unix_ms: T0 + 60_000 }),
    ]);
    expect(find(deltas, 60, 'api', '').map((d) => d.requests)).toEqual([1, 1]);
    expect(find(deltas, 3600, 'api', '')[0].requests).toBe(2);
    expect(find(deltas, 3600, 'api', '', 'orders')[0].requests).toBe(1);
  });

  it('keeps the latest alias seen for a key', () => {
    const deltas = rollupBatch([
      record({ key_hash: 'k1', key_alias: 'old' }),
      record({ key_hash: 'k1' }),
      record({ key_hash: 'k1', key_alias: 'new' }),
    ]);
    expect(find(deltas, 60, 'key', 'k1')[0].label).toBe('new');
  });

  it('truncates long paths and folds all but the busiest into (other)', () => {
    const long = '/' + 'x'.repeat(MAX_PATH_LENGTH + 50);
    const records = [record({ path: long })];
    // Every capped-in path twice, so they outrank the singletons that follow.
    for (let i = 0; i < MAX_PATHS_PER_BUCKET; i += 1) {
      records.push(record({ path: `/p/${i}` }), record({ path: `/p/${i}` }));
    }
    records.push(record({ path: '/rare/a' }), record({ path: '/rare/b' }));
    const deltas = rollupBatch(records);
    const paths = deltas.filter((d) => d.bucketSeconds === 60 && d.dimension === 'path');
    expect(paths).toHaveLength(MAX_PATHS_PER_BUCKET + 1);
    expect(find(deltas, 60, 'path', OTHER_PATHS)[0].requests).toBe(3);
    expect(paths.every((d) => d.value.length <= MAX_PATH_LENGTH)).toBe(true);
    // The fold does not lose requests.
    expect(paths.reduce((total, d) => total + d.requests, 0)).toBe(records.length);
  });
});
