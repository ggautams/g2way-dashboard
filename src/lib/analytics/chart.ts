/**
 * Chart scales and value formatting for the traffic charts (ADR-0013). Pure
 * and universal, so the server-rendered tiles and table and the client chart
 * format numbers identically. Times are shown in UTC, as elsewhere in the
 * dashboard, which also keeps server and client renders identical.
 */

/** What a series measures: requests per second, a fraction shown as %, or milliseconds. */
export type ChartUnit = 'rps' | 'percent' | 'ms';

/**
 * A y-axis from zero: a "nice" step (1, 2, 2.5 or 5 × 10ⁿ) giving at most
 * `target` intervals, and the ticks up to the first one at or above `max`.
 * An all-zero or empty series still gets a unit axis.
 */
export function niceTicks(max: number, target = 4): { max: number; ticks: number[] } {
  if (!(max > 0) || !Number.isFinite(max)) return { max: 1, ticks: [0, 0.5, 1] };
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ??
    10 * magnitude;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; i * step <= top + step / 1e6; i += 1) ticks.push(round(i * step));
  return { max: round(top), ticks };
}

/** Strips floating-point dust (0.30000000000000004 → 0.3). */
function round(n: number): number {
  return Number.parseFloat(n.toPrecision(12));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TICK_INTERVALS = [
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  // The Prometheus-only ranges (90 and 365 days, ADR-0015).
  14 * DAY,
  30 * DAY,
  60 * DAY,
];

/** Epoch-aligned (UTC) x-axis ticks within `[from, to]`, at most `maxTicks` of them. */
export function timeTicks(from: number, to: number, maxTicks = 6): number[] {
  const span = to - from;
  const interval =
    TICK_INTERVALS.find((candidate) => span / candidate <= maxTicks) ?? TICK_INTERVALS.at(-1)!;
  const ticks: number[] = [];
  for (let t = Math.ceil(from / interval) * interval; t <= to; t += interval) ticks.push(t);
  return ticks;
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An axis label: `14:30` within a day's span, `Sep 23` (or `Sep 23 06:00`) beyond. */
export function formatTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (spanMs <= DAY) return time;
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return ms % DAY === 0 ? date : `${date} ${time}`;
}

/** A full timestamp for tooltips and the table: `Sep 23 14:30 UTC`. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

const en = (n: number, digits: number) =>
  n.toLocaleString('en', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A value in its unit, or an em dash for "no requests". */
export function formatValue(value: number | null, unit: ChartUnit): string {
  if (value === null || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'rps':
      if (value === 0) return '0';
      return en(value, value < 10 ? 2 : value < 100 ? 1 : 0);
    case 'percent': {
      const pct = value * 100;
      if (pct === 0) return '0%';
      return `${en(pct, pct >= 10 ? 0 : pct >= 1 ? 1 : 2)}%`;
    }
    case 'ms':
      if (value >= 1000) return `${en(value / 1000, 2)} s`;
      return `${en(value, value < 10 && value !== 0 ? 1 : 0)} ms`;
  }
}

/** Decimals needed to write `n` exactly, capped at 3 (`2.5` → 1, `0.05` → 2). */
function decimalsOf(n: number): number {
  for (let digits = 0; digits < 3; digits += 1) {
    if (Math.abs(round(n * 10 ** digits) - Math.round(n * 10 ** digits)) < 1e-9) return digits;
  }
  return 3;
}

/** An axis tick label: like `formatValue`, with as many decimals as the step needs. */
export function formatTickValue(value: number, step: number, unit: ChartUnit): string {
  switch (unit) {
    case 'percent':
      return `${en(value * 100, decimalsOf(step * 100))}%`;
    case 'ms':
      return step >= 1000
        ? `${en(value / 1000, decimalsOf(step / 1000))} s`
        : `${en(value, decimalsOf(step))} ms`;
    case 'rps':
      return en(value, decimalsOf(step));
  }
}

export const UNIT_LABEL: Record<ChartUnit, string> = {
  rps: 'requests per second',
  percent: 'percent of requests',
  ms: 'milliseconds',
};
