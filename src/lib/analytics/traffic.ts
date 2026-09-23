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
 * Where a traffic view reads from: the dashboard's rollups (ADR-0012, the
 * default) or, where the environment names one, a Prometheus that scrapes the
 * gateway (ADR-0015). Chosen by the user, never switched automatically.
 */
export const TRAFFIC_SOURCES = ['rollups', 'prometheus'] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

/**
 * A fixed time range. `sourceSeconds` is the rollup granularity read;
 * `stepSeconds` is one chart point, a whole multiple of it. Ranges read minute
 * rows while they fit minute retention (ADR-0012 §7); `retainedRange`
 * (`retention.ts`) moves them to hour rows past it. `sources` lists the
 * sources that always offer the range: the long ones are Prometheus's, and the
 * rollups' too only where hour retention covers them (`offersRange`).
 */
export type TrafficRange = {
  /** A fixed range's id, or `custom` for an absolute window (`custom-range.ts`). */
  id: TrafficRangeId | 'custom';
  label: string;
  durationSeconds: number;
  sourceSeconds: RollupBucketSeconds;
  stepSeconds: number;
  sources: readonly TrafficSource[];
  /**
   * A custom range's end (Unix ms, step-aligned, exclusive). Absent on the
   * fixed ranges, whose window ends with the step holding `now`.
   */
  end?: number;
};

export const TRAFFIC_RANGE_IDS = ['1h', '6h', '24h', '7d', '30d', '90d', '1y'] as const;
export type TrafficRangeId = (typeof TRAFFIC_RANGE_IDS)[number];

/** One of the fixed ranges: relative to now, named by its id. */
export type FixedTrafficRange = TrafficRange & { id: TrafficRangeId; end?: undefined };

const BOTH: readonly TrafficSource[] = TRAFFIC_SOURCES;
const PROMETHEUS_ONLY: readonly TrafficSource[] = ['prometheus'];

export const TRAFFIC_RANGES: Record<TrafficRangeId, FixedTrafficRange> = {
  '1h': {
    id: '1h',
    label: 'Last hour',
    durationSeconds: 3_600,
    sourceSeconds: 60,
    stepSeconds: 60,
    sources: BOTH,
  },
  '6h': {
    id: '6h',
    label: 'Last 6 hours',
    durationSeconds: 21_600,
    sourceSeconds: 60,
    stepSeconds: 300,
    sources: BOTH,
  },
  '24h': {
    id: '24h',
    label: 'Last 24 hours',
    durationSeconds: 86_400,
    sourceSeconds: 60,
    stepSeconds: 900,
    sources: BOTH,
  },
  '7d': {
    id: '7d',
    label: 'Last 7 days',
    durationSeconds: 604_800,
    sourceSeconds: 3_600,
    stepSeconds: 3_600,
    sources: BOTH,
  },
  '30d': {
    id: '30d',
    label: 'Last 30 days',
    durationSeconds: 2_592_000,
    sourceSeconds: 3_600,
    stepSeconds: 21_600,
    sources: BOTH,
  },
  '90d': {
    id: '90d',
    label: 'Last 90 days',
    durationSeconds: 7_776_000,
    sourceSeconds: 3_600,
    stepSeconds: 86_400,
    sources: PROMETHEUS_ONLY,
  },
  '1y': {
    id: '1y',
    label: 'Last 365 days',
    durationSeconds: 31_536_000,
    sourceSeconds: 3_600,
    stepSeconds: 86_400,
    sources: PROMETHEUS_ONLY,
  },
};

export const DEFAULT_TRAFFIC_RANGE: TrafficRangeId = '1h';

/**
 * Whether `source` offers the range `id`. The rollups also offer a
 * Prometheus range whose whole window their hour rows still hold, given
 * `hourRetentionDays` (`G2_ANALYTICS_HOUR_RETENTION_DAYS`): `90d` at the
 * default of 90 days, `1y` from 365 (ADR-0015 §2, amended).
 */
export function offersRange(
  id: TrafficRangeId,
  source: TrafficSource,
  hourRetentionDays?: number,
): boolean {
  const range = TRAFFIC_RANGES[id];
  if (range.sources.includes(source)) return true;
  return (
    source === 'rollups' &&
    hourRetentionDays !== undefined &&
    range.durationSeconds <= hourRetentionDays * 86_400
  );
}

/** The ranges `source` offers, in picker order (see `offersRange`). */
export function rangesFor(source: TrafficSource, hourRetentionDays?: number): TrafficRangeId[] {
  return TRAFFIC_RANGE_IDS.filter((id) => offersRange(id, source, hourRetentionDays));
}

/**
 * The range a `?range=` search param names, or the default for anything
 * else, including a range `source` does not offer.
 */
export function parseTrafficRange(
  value: unknown,
  source: TrafficSource = 'rollups',
  hourRetentionDays?: number,
): FixedTrafficRange {
  const id = rangesFor(source, hourRetentionDays).find((candidate) => candidate === value);
  return TRAFFIC_RANGES[id ?? DEFAULT_TRAFFIC_RANGE];
}

/**
 * The source a `?source=` search param asks for, given whether the
 * environment has a Prometheus. Anything but `prometheus` is the rollups; a
 * Prometheus request without one falls back with a note, never silently.
 */
export function parseTrafficSource(
  value: unknown,
  prometheusConfigured: boolean,
): { source: TrafficSource; note: string | null } {
  if (value !== 'prometheus') return { source: 'rollups', note: null };
  if (prometheusConfigured) return { source: 'prometheus', note: null };
  return {
    source: 'rollups',
    note: 'source=prometheus: this environment has no Prometheus configured; showing the rollups.',
  };
}

/**
 * The window a range covers at `now`: `points` whole steps, epoch-aligned,
 * the last of which contains `now` (so it is still filling). A custom range
 * ends at its own `end` instead, which may be long past. Query rows with
 * `from <= bucket_start < to`.
 */
export function trafficWindow(range: TrafficRange, now: number) {
  const stepMs = range.stepSeconds * 1000;
  const to = range.end ?? Math.floor(now / stepMs) * stepMs + stepMs;
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
  /** Whether the last step holds `now`, so it is still filling. False for a custom range in the past. */
  filling: boolean;
  points: TrafficPoint[];
  summary: TrafficSummary;
};

/**
 * How far a source's buckets can be trusted beyond their counters.
 * `exactMax: false` (Prometheus, ADR-0015 §3) means `latencyMaxMs` only bounds
 * the interpolation and is not shown as a maximum.
 */
export type SummaryOptions = { exactMax?: boolean };

/** The chart series and range totals for `range` at `now`, from the window's source buckets. */
export function trafficSeries(
  range: TrafficRange,
  buckets: readonly TrafficBucket[],
  now: number,
  options: SummaryOptions = {},
): Traffic {
  const window = trafficWindow(range, now);
  const steps = resample(buckets, window);
  const points = steps.map((step) => ({
    start: step.start,
    ...derive(step, elapsedSeconds(step.start, window.stepMs, now)),
  }));
  const total = emptyBucket(window.from);
  for (const step of steps) addBucket(total, step);
  const summary = summarise(
    total,
    elapsedSeconds(window.from, window.to - window.from, now),
    options,
  );
  return { range, from: window.from, to: window.to, filling: window.to > now, points, summary };
}

/**
 * The range in running text, after a comma: `last hour`, or
 * `from 2026-09-01 00:00 to 2026-09-02 00:00 UTC` for a custom range.
 */
export function rangePhrase(range: TrafficRange): string {
  return range.id === 'custom' ? range.label : range.label.toLowerCase();
}

/** The range after "recorded": `in the last hour`, or a custom range's `from … to … UTC`. */
export function rangeWithin(range: TrafficRange): string {
  return range.id === 'custom' ? range.label : `in the ${range.label.toLowerCase()}`;
}

/** Totals over `seconds` as the headline figures: rates, estimated percentiles, mean and max. */
export function summarise(
  total: TrafficBucket,
  seconds: number,
  options: SummaryOptions = {},
): TrafficSummary {
  const exactMax = options.exactMax ?? true;
  return {
    ...derive(total, seconds),
    latencyAvgMs: total.requests === 0 ? null : total.latencySumMs / total.requests,
    latencyMaxMs: total.requests === 0 || !exactMax ? null : total.latencyMaxMs,
  };
}
