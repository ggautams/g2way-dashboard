import {
  LATENCY_BOUNDS_MS,
  latencyBucketKey,
  type LatencyBucketKey,
  type RollupBucketSeconds,
} from '@/lib/db/schema/shared';

/**
 * Traffic series for the `/analytics` charts, computed from rollup rows
 * (ADR-0012 §5). Pure and universal: the page sums rows in the database
 * (`queryTrafficBuckets`), then this module re-buckets them to the chart's
 * step, gap-fills empty steps, and derives RPS, error rates and estimated
 * latency percentiles.
 */

/** The histogram counters of a rollup, by row property. */
export type LatencyHistogram = Record<LatencyBucketKey, number> & { latencyOver: number };

/** One source bucket's totals (summed over APIs, or one API), as read from the rollups. */
export type TrafficBucket = LatencyHistogram & {
  /** The bucket's first millisecond (Unix ms). */
  start: number;
  requests: number;
  status1xx: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  latencySumMs: number;
  /** A maximum, not a sum. */
  latencyMaxMs: number;
};

/** The additive counters of a `TrafficBucket` (everything but `start` and the max). */
export const TRAFFIC_COUNTERS = [
  'requests',
  'status1xx',
  'status2xx',
  'status3xx',
  'status4xx',
  'status5xx',
  'latencySumMs',
  ...LATENCY_BOUNDS_MS.map(latencyBucketKey),
  'latencyOver',
] as const satisfies readonly (keyof TrafficBucket)[];

export type TrafficCounter = (typeof TRAFFIC_COUNTERS)[number];

/**
 * A fixed time range. `sourceSeconds` is the rollup granularity read;
 * `stepSeconds` is one chart point, a whole multiple of it. Ranges read minute
 * rows only while they fit the default minute retention (3 days, ADR-0012 §7).
 */
export type TrafficRange = {
  id: TrafficRangeId;
  label: string;
  durationSeconds: number;
  sourceSeconds: RollupBucketSeconds;
  stepSeconds: number;
};

export const TRAFFIC_RANGE_IDS = ['1h', '6h', '24h', '7d', '30d'] as const;
export type TrafficRangeId = (typeof TRAFFIC_RANGE_IDS)[number];

export const TRAFFIC_RANGES: Record<TrafficRangeId, TrafficRange> = {
  '1h': {
    id: '1h',
    label: 'Last hour',
    durationSeconds: 3_600,
    sourceSeconds: 60,
    stepSeconds: 60,
  },
  '6h': {
    id: '6h',
    label: 'Last 6 hours',
    durationSeconds: 21_600,
    sourceSeconds: 60,
    stepSeconds: 300,
  },
  '24h': {
    id: '24h',
    label: 'Last 24 hours',
    durationSeconds: 86_400,
    sourceSeconds: 60,
    stepSeconds: 900,
  },
  '7d': {
    id: '7d',
    label: 'Last 7 days',
    durationSeconds: 604_800,
    sourceSeconds: 3_600,
    stepSeconds: 3_600,
  },
  '30d': {
    id: '30d',
    label: 'Last 30 days',
    durationSeconds: 2_592_000,
    sourceSeconds: 3_600,
    stepSeconds: 21_600,
  },
};

export const DEFAULT_TRAFFIC_RANGE: TrafficRangeId = '1h';

/** The range a `?range=` search param names, or the default for anything else. */
export function parseTrafficRange(value: unknown): TrafficRange {
  const id = TRAFFIC_RANGE_IDS.find((candidate) => candidate === value);
  return TRAFFIC_RANGES[id ?? DEFAULT_TRAFFIC_RANGE];
}

/**
 * The window a range covers at `now`: `points` whole steps, epoch-aligned,
 * the last of which contains `now` (so it is still filling). Query rows with
 * `from <= bucket_start < to`.
 */
export function trafficWindow(range: TrafficRange, now: number) {
  const stepMs = range.stepSeconds * 1000;
  const to = Math.floor(now / stepMs) * stepMs + stepMs;
  const points = Math.round(range.durationSeconds / range.stepSeconds);
  return { from: to - points * stepMs, to, stepMs, points };
}

export function emptyBucket(start: number): TrafficBucket {
  const bucket = { start, latencyMaxMs: 0 } as TrafficBucket;
  for (const name of TRAFFIC_COUNTERS) bucket[name] = 0;
  return bucket;
}

/** Adds `from` into `into`: counters sum, the max merges. */
export function addBucket(into: TrafficBucket, from: TrafficBucket): void {
  for (const name of TRAFFIC_COUNTERS) into[name] += from[name];
  into.latencyMaxMs = Math.max(into.latencyMaxMs, from.latencyMaxMs);
}

/**
 * Folds source buckets into `points` steps of `stepMs` from `from`, one per
 * step whether or not it saw traffic. Buckets outside the window are ignored.
 */
export function resample(
  buckets: readonly TrafficBucket[],
  window: { from: number; stepMs: number; points: number },
): TrafficBucket[] {
  const steps = Array.from({ length: window.points }, (_, i) =>
    emptyBucket(window.from + i * window.stepMs),
  );
  for (const bucket of buckets) {
    const index = Math.floor((bucket.start - window.from) / window.stepMs);
    if (index >= 0 && index < steps.length) addBucket(steps[index], bucket);
  }
  return steps;
}

/**
 * Estimates the `q` quantile (0 < q <= 1) of latency from the histogram, in
 * ms: find the bucket holding the q·n-th request and interpolate linearly
 * inside it. A bucket spans from the previous bound (0 for the first) to its
 * own; the exact maximum narrows the top, and bounds the open-ended
 * `latencyOver` bucket. `null` when there were no requests. An estimate, never
 * exact: raw latencies are not kept (ADR-0012 §6).
 */
export function estimatePercentile(
  histogram: LatencyHistogram & { latencyMaxMs: number },
  q: number,
): number | null {
  const counts = [
    ...LATENCY_BOUNDS_MS.map((bound) => ({ upper: bound, n: histogram[latencyBucketKey(bound)] })),
    { upper: Number.POSITIVE_INFINITY, n: histogram.latencyOver },
  ];
  const total = counts.reduce((sum, bucket) => sum + bucket.n, 0);
  if (total === 0) return null;
  const rank = Math.min(Math.max(q, 0), 1) * total;
  let seen = 0;
  let lower = 0;
  for (const { upper, n } of counts) {
    if (n > 0 && seen + n >= rank) {
      // The maximum is exact; a max below this bucket's lower bound means the
      // rows disagree, so fall back to the bound.
      const max = histogram.latencyMaxMs;
      const top = max >= lower ? Math.min(upper, max) : Number.isFinite(upper) ? upper : lower;
      return lower + (top - lower) * ((rank - seen) / n);
    }
    seen += n;
    if (Number.isFinite(upper)) lower = upper;
  }
  return lower;
}

/** One chart point. Rates are fractions (0–1); latencies are ms. `null` means no requests. */
export type TrafficPoint = {
  start: number;
  /** Seconds of the step that have elapsed: the whole step, except for the one still filling. */
  seconds: number;
  requests: number;
  rps: number;
  serverErrorRate: number | null;
  clientErrorRate: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

export type TrafficSummary = Omit<TrafficPoint, 'start'> & {
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
};

function derive(bucket: TrafficBucket, seconds: number): Omit<TrafficPoint, 'start'> {
  const { requests } = bucket;
  const share = (n: number) => (requests === 0 ? null : n / requests);
  return {
    seconds,
    requests,
    rps: requests / seconds,
    serverErrorRate: share(bucket.status5xx),
    clientErrorRate: share(bucket.status4xx),
    p50: estimatePercentile(bucket, 0.5),
    p95: estimatePercentile(bucket, 0.95),
    p99: estimatePercentile(bucket, 0.99),
  };
}

/** Seconds of `[start, start + stepMs)` before `now`, at least 1 (so RPS stays finite). */
export function elapsedSeconds(start: number, stepMs: number, now: number): number {
  return Math.max(1, Math.min(stepMs, now - start) / 1000);
}

export type Traffic = {
  range: TrafficRange;
  from: number;
  to: number;
  points: TrafficPoint[];
  summary: TrafficSummary;
};

/** The chart series and range totals for `range` at `now`, from the window's source buckets. */
export function trafficSeries(
  range: TrafficRange,
  buckets: readonly TrafficBucket[],
  now: number,
): Traffic {
  const window = trafficWindow(range, now);
  const steps = resample(buckets, window);
  const points = steps.map((step) => ({
    start: step.start,
    ...derive(step, elapsedSeconds(step.start, window.stepMs, now)),
  }));
  const total = emptyBucket(window.from);
  for (const step of steps) addBucket(total, step);
  const summary = summarise(total, elapsedSeconds(window.from, window.to - window.from, now));
  return { range, from: window.from, to: window.to, points, summary };
}

/** Totals over `seconds` as the headline figures: rates, estimated percentiles, mean and max. */
export function summarise(total: TrafficBucket, seconds: number): TrafficSummary {
  return {
    ...derive(total, seconds),
    latencyAvgMs: total.requests === 0 ? null : total.latencySumMs / total.requests,
    latencyMaxMs: total.requests === 0 ? null : total.latencyMaxMs,
  };
}
