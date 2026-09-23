import {
  LATENCY_BOUNDS_MS,
  ROLLUP_BUCKET_SECONDS,
  latencyBucketKey,
  type LatencyBucketKey,
  type RollupBucketSeconds,
  type RollupDimension,
} from '@/lib/db/schema/shared';
import type { AnalyticsRecord } from './record';

/**
 * Folds a batch of analytics records into rollup deltas (ADR-0012 §5). Pure:
 * the worker adds the deltas to `analytics_rollups` in one transaction.
 *
 * Every record adds to five rows per granularity (minute and hour): its API's
 * total and one row each for its key, method, status and path within that API.
 */

/** Paths longer than this are cut, so one odd request cannot bloat the table. */
export const MAX_PATH_LENGTH = 512;

/** Distinct paths kept per API and bucket, per batch; the rest fold into `OTHER_PATHS`. */
export const MAX_PATHS_PER_BUCKET = 200;

/** The path value past the cap. Real paths start with `/`, so it cannot collide. */
export const OTHER_PATHS = '(other)';

/** Additive counters of a rollup row, by schema property name. */
export type RollupCounters = {
  requests: number;
  status1xx: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  latencySumMs: number;
  upstreamRequests: number;
  upstreamLatencySumMs: number;
  requestBytes: number;
  responseBytes: number;
  latencyOver: number;
} & Record<LatencyBucketKey, number>;

/** Every additive counter's property name (the upsert adds each). */
export const ROLLUP_COUNTERS: readonly (keyof RollupCounters)[] = [
  'requests',
  'status1xx',
  'status2xx',
  'status3xx',
  'status4xx',
  'status5xx',
  'latencySumMs',
  'upstreamRequests',
  'upstreamLatencySumMs',
  'requestBytes',
  'responseBytes',
  ...LATENCY_BOUNDS_MS.map(latencyBucketKey),
  'latencyOver',
];

/** What one batch adds to one rollup row. */
export type RollupDelta = RollupCounters & {
  bucketSeconds: RollupBucketSeconds;
  bucketStart: Date;
  apiId: string;
  dimension: RollupDimension;
  value: string;
  /** The latest `key_alias` in the batch, on `key` rows; otherwise null. */
  label: string | null;
  /** Merged with `max`, not added. */
  latencyMaxMs: number;
};

function emptyCounters(): RollupCounters {
  return Object.fromEntries(ROLLUP_COUNTERS.map((name) => [name, 0])) as RollupCounters;
}

/** The histogram counter a latency falls in: the first bound it does not exceed. */
export function latencyBucketOf(latencyMs: number): LatencyBucketKey | 'latencyOver' {
  const bound = LATENCY_BOUNDS_MS.find((candidate) => latencyMs <= candidate);
  return bound === undefined ? 'latencyOver' : latencyBucketKey(bound);
}

const STATUS_CLASS: Record<number, keyof RollupCounters> = {
  1: 'status1xx',
  2: 'status2xx',
  3: 'status3xx',
  4: 'status4xx',
  5: 'status5xx',
};

function add(delta: RollupDelta, record: AnalyticsRecord): void {
  delta.requests += 1;
  const statusClass = STATUS_CLASS[Math.floor(record.status / 100)];
  if (statusClass !== undefined) delta[statusClass] += 1;
  delta.latencySumMs += record.latency_ms;
  delta.latencyMaxMs = Math.max(delta.latencyMaxMs, record.latency_ms);
  delta[latencyBucketOf(record.latency_ms)] += 1;
  if (record.upstream_latency_ms !== undefined) {
    delta.upstreamRequests += 1;
    delta.upstreamLatencySumMs += record.upstream_latency_ms;
  }
  delta.requestBytes += record.request_content_length ?? 0;
  delta.responseBytes += record.response_content_length ?? 0;
}

export function bucketStartOf(timestampMs: number, bucketSeconds: RollupBucketSeconds): Date {
  const width = bucketSeconds * 1000;
  return new Date(Math.floor(timestampMs / width) * width);
}

/**
 * Folds `records` into one delta per (granularity, bucket, API, dimension,
 * value). `pathOf` gives the `path` value filed for a record: the worker
 * passes the templated path (`path-template.ts`); the default is the raw path.
 * Paths past `MAX_PATHS_PER_BUCKET` per API and bucket (the busiest are
 * kept, counted after templating) fold into `OTHER_PATHS`.
 */
export function rollupBatch(
  records: readonly AnalyticsRecord[],
  pathOf: (record: AnalyticsRecord) => string = (record) => record.path,
): RollupDelta[] {
  const deltas = new Map<string, RollupDelta>();
  const row = (
    bucketSeconds: RollupBucketSeconds,
    bucketStart: Date,
    apiId: string,
    dimension: RollupDimension,
    value: string,
  ): RollupDelta => {
    const id = JSON.stringify([bucketSeconds, bucketStart.getTime(), apiId, dimension, value]);
    let delta = deltas.get(id);
    if (delta === undefined) {
      delta = {
        ...emptyCounters(),
        bucketSeconds,
        bucketStart,
        apiId,
        dimension,
        value,
        label: null,
        latencyMaxMs: 0,
      };
      deltas.set(id, delta);
    }
    return delta;
  };

  const paths = records.map((record) => truncatePath(pathOf(record)));
  const kept = keptPaths(records, paths);
  for (const [index, record] of records.entries()) {
    for (const bucketSeconds of ROLLUP_BUCKET_SECONDS) {
      const start = bucketStartOf(record.timestamp_unix_ms, bucketSeconds);
      const at = (dimension: RollupDimension, value: string) =>
        row(bucketSeconds, start, record.api_id, dimension, value);
      add(at('api', ''), record);
      const key = at('key', record.key_hash ?? '');
      add(key, record);
      if (record.key_alias !== undefined) key.label = record.key_alias;
      add(at('method', record.method), record);
      add(at('status', String(record.status)), record);
      const path = paths[index] as string;
      const pathKey = JSON.stringify([bucketSeconds, start.getTime(), record.api_id]);
      add(at('path', kept.get(pathKey)?.has(path) ? path : OTHER_PATHS), record);
    }
  }
  return [...deltas.values()];
}

/** Cuts a path to `MAX_PATH_LENGTH` characters, as the rollups and the tail store it. */
export function truncatePath(path: string): string {
  return path.length > MAX_PATH_LENGTH ? path.slice(0, MAX_PATH_LENGTH) : path;
}

/** Per granularity, bucket and API: the busiest `MAX_PATHS_PER_BUCKET` paths. */
function keptPaths(
  records: readonly AnalyticsRecord[],
  pathValues: readonly string[],
): Map<string, Set<string>> {
  const counts = new Map<string, Map<string, number>>();
  for (const [index, record] of records.entries()) {
    const path = pathValues[index] as string;
    for (const bucketSeconds of ROLLUP_BUCKET_SECONDS) {
      const start = bucketStartOf(record.timestamp_unix_ms, bucketSeconds);
      const id = JSON.stringify([bucketSeconds, start.getTime(), record.api_id]);
      let paths = counts.get(id);
      if (paths === undefined) counts.set(id, (paths = new Map()));
      paths.set(path, (paths.get(path) ?? 0) + 1);
    }
  }
  const kept = new Map<string, Set<string>>();
  for (const [id, paths] of counts) {
    const busiest = [...paths.entries()]
      // Busiest first; ties by path, so the cut is deterministic.
      .sort(([pathA, a], [pathB, b]) => b - a || (pathA < pathB ? -1 : pathA > pathB ? 1 : 0))
      .slice(0, MAX_PATHS_PER_BUCKET)
      .map(([path]) => path);
    kept.set(id, new Set(busiest));
  }
  return kept;
}
