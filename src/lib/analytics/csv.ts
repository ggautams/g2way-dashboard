import {
  elapsedSeconds,
  resample,
  summarise,
  trafficWindow,
  type SummaryOptions,
  type TrafficBucket,
  type TrafficRange,
  type TrafficSummary,
} from './traffic';

/**
 * CSV export of an `/analytics` view (ADR-0013 §8): the time series and the
 * breakdown, each as its own file. Pure and universal; the route handler
 * (`src/lib/analytics/export.ts`) loads the buckets.
 *
 * A file opens with `#` rows describing the view (a CSV reader's usual
 * comment marker), then one header row and the data. Every text cell goes
 * through `csvCell`, which defuses spreadsheet formulas.
 */

/** Cells starting with these run as formulas in a spreadsheet (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell. Text that a spreadsheet would read as a formula gets a
 * leading `'`; a cell holding a comma, quote or line break is quoted. Numbers
 * are written as they are; `null` is an empty cell.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(cells: readonly (string | number | null)[]): string {
  return cells.map(csvCell).join(',');
}

/** A whole file: the `#` description rows, a header, the data; CRLF line ends (RFC 4180). */
export function toCsv(
  meta: readonly (readonly [string, string])[],
  header: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const lines = [
    ...meta.map(([name, value]) => csvRow([`# ${name}`, value])),
    csvRow(header),
    ...rows.map((row) => csvRow(row)),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** Rates and latencies to six decimals: enough for any chart, no float dust. */
function num(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(6));
}

const METRIC_HEADER = [
  'req_per_s',
  'error_rate_5xx',
  'rate_4xx',
  'latency_p50_ms',
  'latency_p95_ms',
  'latency_p99_ms',
  'latency_avg_ms',
  'latency_max_ms',
] as const;

function metrics(summary: TrafficSummary): (number | null)[] {
  return [
    num(summary.rps),
    num(summary.serverErrorRate),
    num(summary.clientErrorRate),
    num(summary.p50),
    num(summary.p95),
    num(summary.p99),
    num(summary.latencyAvgMs),
    num(summary.latencyMaxMs),
  ];
}

const STATUS_HEADER = ['status_1xx', 'status_2xx', 'status_3xx', 'status_4xx', 'status_5xx'];

function statuses(bucket: TrafficBucket): number[] {
  return [bucket.status1xx, bucket.status2xx, bucket.status3xx, bucket.status4xx, bucket.status5xx];
}

export const SERIES_HEADER = [
  'step_start_utc',
  'requests',
  ...STATUS_HEADER,
  ...METRIC_HEADER,
] as const;

/**
 * One row per chart step, oldest first, empty steps included (they are real
 * zeroes, not gaps). The rate of a step still filling divides by the time
 * elapsed in it, as the chart does.
 */
export function seriesRows(
  range: TrafficRange,
  buckets: readonly TrafficBucket[],
  now: number,
  options: SummaryOptions,
): (string | number | null)[][] {
  const window = trafficWindow(range, now);
  return resample(buckets, window).map((step) => [
    new Date(step.start).toISOString(),
    step.requests,
    ...statuses(step),
    ...metrics(summarise(step, elapsedSeconds(step.start, window.stepMs, now), options)),
  ]);
}

export const BREAKDOWN_HEADER = [
  'dimension',
  'value',
  'label',
  'requests',
  'share',
  ...STATUS_HEADER,
  ...METRIC_HEADER,
] as const;

/** One breakdown group as the export shows it: the raw value and its display label. */
export type BreakdownExportRow = {
  value: string;
  label: string;
  bucket: TrafficBucket;
};

/** One row per group, busiest first, then "Everything else" when the groups do not add up. */
export function breakdownRows(
  dimension: string,
  groups: readonly BreakdownExportRow[],
  rest: TrafficBucket | null,
  total: number,
  seconds: number,
  options: SummaryOptions,
): (string | number | null)[][] {
  const row = (value: string, label: string, bucket: TrafficBucket) => [
    dimension,
    value,
    label,
    bucket.requests,
    num(total === 0 ? 0 : bucket.requests / total),
    ...statuses(bucket),
    ...metrics(summarise(bucket, seconds, options)),
  ];
  const rows = groups.map((group) => row(group.value, group.label, group.bucket));
  if (rest !== null && rest.requests > 0) rows.push(row('', 'Everything else', rest));
  return rows;
}

/** A file name safe on every OS: `g2way-traffic-series-prod-20260901T0000Z-20260902T0000Z.csv`. */
export function exportFileName(
  table: 'series' | 'breakdown',
  environment: string,
  from: number,
  to: number,
): string {
  const stamp = (ms: number) =>
    new Date(ms).toISOString().slice(0, 16).replaceAll(/[-:]/g, '').concat('Z');
  const env = environment.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return `g2way-traffic-${table}-${env}-${stamp(from)}-${stamp(to)}.csv`;
}
