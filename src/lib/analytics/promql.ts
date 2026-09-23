import { LATENCY_BOUNDS_MS, latencyBucketKey } from '@/lib/db/schema/shared';
import { totalOf, type BreakdownGroup } from './drill';
import { emptyBucket, type TrafficBucket } from './traffic';

/**
 * PromQL for the Prometheus datasource (ADR-0015): the selectors and queries
 * over g2way's request-duration histogram, and the mapping of their
 * `query_range` matrices onto the rollups' `TrafficBucket`, so the charts,
 * summaries and breakdowns downstream are the rollups' own. Pure; the HTTP
 * side is `prometheus.ts`.
 *
 * Everything here mirrors g2way's `crates/g2-middleware/src/metrics.rs`
 * (instrument, attributes, bucket bounds) as rendered by
 * `opentelemetry_prometheus` (`crates/g2-telemetry/src/metrics.rs`): the
 * `metrics` area of `contracts/watch.json` flags a change to either.
 */

/**
 * The metric family name of g2way's `http.server.request.duration` histogram
 * (unit `s`), as `_bucket`, `_count` and `_sum` series.
 */
export const G2_REQUEST_DURATION = 'http_server_request_duration_seconds';

/** The histogram's labels: OTel attribute names with dots made underscores. */
export const G2_METRIC_LABELS = {
  /** The API's listen path: one value per API, so never a request path. */
  route: 'http_route',
  api: 'g2_api_id',
  org: 'g2_org_id',
  status: 'http_response_status_code',
} as const;

/** g2way's `DURATION_BOUNDARIES_SECS`: the histogram's finite `le` bounds, in seconds. */
export const G2_DURATION_BOUNDS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
] as const;

/** A PromQL string literal: `value` quoted, with backslash, quote and newline escaped. */
export function quoteLabelValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export type PromSelection = {
  orgId: string;
  apiId: string | null;
  /** A status class (`5xx`) or an exact code (`503`); `null` for every status. */
  status: string | null;
  /** The environment's `G2_PROMETHEUS_SELECTOR` matchers, already validated. */
  extra: string | null;
};

/** The label selector, braces included, for one org, API and status selection. */
export function promSelector(selection: PromSelection): string {
  const matchers = [`${G2_METRIC_LABELS.org}=${quoteLabelValue(selection.orgId)}`];
  if (selection.apiId !== null) {
    matchers.push(`${G2_METRIC_LABELS.api}=${quoteLabelValue(selection.apiId)}`);
  }
  if (selection.status !== null) {
    const status = selection.status;
    matchers.push(
      /^[1-5]xx$/.test(status)
        ? `${G2_METRIC_LABELS.status}=~"${status[0]}.."`
        : `${G2_METRIC_LABELS.status}=${quoteLabelValue(status)}`,
    );
  }
  if (selection.extra !== null) matchers.push(selection.extra);
  return `{${matchers.join(',')}}`;
}

/**
 * What a Prometheus breakdown groups by, as the rollups' `BreakdownGroup`
 * over the two dimensions the labels carry: `api` by `g2_api_id`, `class` and
 * `value` (codes, inside a class focus) by `http_response_status_code`.
 */
export type PromGrouping = { group: BreakdownGroup; dimension: 'api' | 'status' } | null;

function groupLabel(grouping: PromGrouping): string | null {
  if (grouping === null) return null;
  return grouping.dimension === 'api' ? G2_METRIC_LABELS.api : G2_METRIC_LABELS.status;
}

function by(labels: readonly (string | null)[]): string {
  const kept = labels.filter((label): label is string => label !== null);
  return kept.length === 0 ? 'sum' : `sum by (${[...new Set(kept)].join(', ')})`;
}

export type TrafficQueries = { count: string; bucket: string; sum: string };

/**
 * The three range queries behind one view: requests by status code, the
 * cumulative latency buckets by `le`, and the latency sum, each the
 * `increase()` over one step and summed over replicas (ADR-0015 §3).
 */
export function trafficQueries(
  selector: string,
  stepSeconds: number,
  grouping: PromGrouping,
): TrafficQueries {
  const group = groupLabel(grouping);
  const increase = (suffix: string) =>
    `(increase(${G2_REQUEST_DURATION}_${suffix}${selector}[${stepSeconds}s]))`;
  return {
    count: `${by([group, G2_METRIC_LABELS.status])} ${increase('count')}`,
    bucket: `${by([group, 'le'])} ${increase('bucket')}`,
    sum: `${by([group])} ${increase('sum')}`,
  };
}

/** One series of a `query_range` matrix: its labels and `[unix seconds, "value"]` samples. */
export type PromSeries = {
  metric: Record<string, string>;
  values: [number, string][];
};

export type TrafficMatrices = {
  count: readonly PromSeries[];
  bucket: readonly PromSeries[];
  sum: readonly PromSeries[];
};

type Accumulator = {
  statuses: number[]; // index 0: codes outside 1xx–5xx; 1–5 the classes
  cumulative: Map<number, number>; // le (seconds, Infinity for +Inf) → count
  sumSeconds: number;
};

/** The group a series belongs to, `''` when ungrouped, `null` when it cannot be placed. */
function groupOf(metric: Record<string, string>, grouping: PromGrouping): string | null {
  if (grouping === null) return '';
  const value = metric[groupLabel(grouping) ?? ''];
  if (value === undefined) return null;
  if (grouping.group === 'class') return /^[1-5]\d\d$/.test(value) ? value[0] : null;
  return value;
}

function sampleValue(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The matrices as source buckets per group (`''` alone when ungrouped): a
 * sample at `t` is the step `[t − step, t)`. Counts are rounded, since
 * `increase()` extrapolates; groups that saw no requests are left out.
 */
export function bucketsFromMatrices(
  matrices: TrafficMatrices,
  stepSeconds: number,
  grouping: PromGrouping,
): Map<string, TrafficBucket[]> {
  const stepMs = stepSeconds * 1000;
  const groups = new Map<string, Map<number, Accumulator>>();
  const at = (metric: Record<string, string>, t: number): Accumulator | null => {
    const group = groupOf(metric, grouping);
    if (group === null) return null;
    let steps = groups.get(group);
    if (steps === undefined) groups.set(group, (steps = new Map()));
    const start = Math.round(t * 1000) - stepMs;
    let acc = steps.get(start);
    if (acc === undefined) {
      acc = { statuses: [0, 0, 0, 0, 0, 0], cumulative: new Map(), sumSeconds: 0 };
      steps.set(start, acc);
    }
    return acc;
  };
  const each = (
    series: readonly PromSeries[],
    add: (acc: Accumulator, value: number, metric: Record<string, string>) => void,
  ) => {
    for (const { metric, values } of series) {
      for (const [t, raw] of values) {
        const value = sampleValue(raw);
        if (value === null) continue;
        const acc = at(metric, t);
        if (acc !== null) add(acc, value, metric);
      }
    }
  };
  each(matrices.count, (acc, value, metric) => {
    const code = metric[G2_METRIC_LABELS.status] ?? '';
    acc.statuses[/^[1-5]\d\d$/.test(code) ? Number(code[0]) : 0] += value;
  });
  each(matrices.bucket, (acc, value, metric) => {
    // Prometheus spells the open bucket `+Inf`, which Number() reads as NaN.
    const le = metric.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(metric.le);
    if (!Number.isNaN(le)) acc.cumulative.set(le, (acc.cumulative.get(le) ?? 0) + value);
  });
  each(matrices.sum, (acc, value) => {
    acc.sumSeconds += value;
  });

  const out = new Map<string, TrafficBucket[]>();
  for (const [group, steps] of groups) {
    const buckets = [...steps.entries()]
      .sort(([a], [b]) => a - b)
      .map(([start, acc]) => toBucket(start, acc));
    if (buckets.some((bucket) => bucket.requests > 0)) out.set(group, buckets);
  }
  return out;
}

/** One step's accumulated samples as a rollup-shaped bucket (ADR-0015 §3). */
function toBucket(start: number, acc: Accumulator): TrafficBucket {
  const bucket = emptyBucket(start);
  const [other, s1, s2, s3, s4, s5] = acc.statuses.map(Math.round);
  bucket.status1xx = s1;
  bucket.status2xx = s2;
  bucket.status3xx = s3;
  bucket.status4xx = s4;
  bucket.status5xx = s5;
  bucket.requests = other + s1 + s2 + s3 + s4 + s5;
  bucket.latencySumMs = acc.sumSeconds * 1000;

  // Cumulative counts made monotone (each series is extrapolated on its own),
  // then read at each rollup bound: the count at the largest `le` at or below it.
  const les = [...acc.cumulative.entries()].sort(([a], [b]) => a - b);
  let running = 0;
  const monotone = les.map(([le, count]) => {
    running = Math.max(running, count);
    return { leMs: le * 1000, count: running };
  });
  const cumulativeAt = (boundMs: number) => {
    let count = 0;
    for (const entry of monotone) if (entry.leMs <= boundMs + 1e-9) count = entry.count;
    return Math.round(count);
  };
  const total = Math.round(running);
  let previous = 0;
  let highest = 0;
  for (const bound of LATENCY_BOUNDS_MS) {
    const cumulative = cumulativeAt(bound);
    const n = cumulative - previous;
    bucket[latencyBucketKey(bound)] = n;
    if (n > 0) highest = bound;
    previous = cumulative;
  }
  bucket.latencyOver = Math.max(0, total - previous);
  // The metric keeps no maximum; the top of the highest non-empty bucket only
  // bounds the interpolation, and the page never shows it (`exactMax: false`).
  bucket.latencyMaxMs = bucket.latencyOver > 0 ? LATENCY_BOUNDS_MS.at(-1)! : highest;
  return bucket;
}

/**
 * Per-group totals over the window, busiest first (ties by group), as the
 * rollups' `queryBreakdown` returns them; Prometheus has no alias labels.
 */
export function breakdownTotals(
  groups: ReadonlyMap<string, readonly TrafficBucket[]>,
  limit: number,
): (Omit<TrafficBucket, 'start'> & { group: string; label: null })[] {
  const rows = [...groups.entries()].map(([group, buckets]) => {
    const { start, ...counters } = totalOf(buckets, 0);
    void start;
    return { group, label: null, ...counters };
  });
  rows.sort(
    (a, b) => b.requests - a.requests || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0),
  );
  return rows.slice(0, limit);
}
