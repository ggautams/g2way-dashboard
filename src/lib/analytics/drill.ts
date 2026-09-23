import type { RollupDimension } from '@/lib/db/schema/shared';
import { formatUtcMinute, type CustomWindow } from './custom-range';
import {
  DEFAULT_TRAFFIC_RANGE,
  TRAFFIC_COUNTERS,
  offersRange,
  addBucket,
  elapsedSeconds,
  emptyBucket,
  rangesFor,
  resample,
  trafficWindow,
  type TrafficBucket,
  type TrafficRange,
  type TrafficRangeId,
  type TrafficSource,
} from './traffic';

/**
 * Drill-down on `/analytics` (ADR-0012 §5): narrow the traffic to one API
 * and to one value of one other dimension, and break the result down by a
 * dimension. Pure and universal: it parses and writes the URL, decides which
 * breakdowns the rollups can answer, and folds breakdown lines into at most
 * three chart series (ADR-0013 §2).
 *
 * The rollups store one dimension per row, always with its API. So a
 * selection is an API (or all of them) and at most one of key, status,
 * method and path. Key × path, or method × status, is not stored and is
 * never offered.
 */

/** A status class, by its first digit. */
export type StatusClass = 1 | 2 | 3 | 4 | 5;

/** What a breakdown groups the selected rows by: their value, their API, or a status class. */
export type BreakdownGroup = 'value' | 'api' | 'class';

/** The dimensions a drill-down narrows to one value of, besides the API. */
export const FOCUS_DIMENSIONS = ['key', 'status', 'method', 'path'] as const;
export type FocusDimension = (typeof FOCUS_DIMENSIONS)[number];

/**
 * The dimensions g2way's request-duration histogram carries as labels
 * (`g2_api_id`, `http_response_status_code`): all a Prometheus view can
 * narrow or break down by (ADR-0015 §4).
 */
export const PROMETHEUS_DIMENSIONS: readonly BreakdownDimension[] = ['api', 'status'];

/** Breakdown tabs, in display order. */
export const BREAKDOWN_DIMENSIONS = [
  'api',
  'status',
  'method',
  'path',
  'key',
] as const satisfies readonly RollupDimension[];
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<BreakdownDimension, string> = {
  api: 'API',
  status: 'Status',
  method: 'Method',
  path: 'Path',
  key: 'Key',
};

/**
 * One value of one dimension. A `status` value is a class (`5xx`) or an exact
 * code (`503`); a `key` value is a key hash, or `''` for keyless requests.
 */
export type DrillFocus = { dimension: FocusDimension; value: string };

export type Drill = {
  apiId: string | null;
  focus: DrillFocus | null;
  /** The breakdown shown; `null` when the selection cannot be split further. */
  by: BreakdownDimension | null;
  /** Parameters that were ignored, and why. Shown on the page, never silently dropped. */
  notes: string[];
};

type SearchParams = Record<string, string | string[] | undefined>;

const MAX_PARAM = 512;
const CONTROL = /[\u0000-\u001f\u007f]/;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Why `value` is not a valid focus on `dimension`, or `null` when it is. */
function focusProblem(dimension: FocusDimension, value: string): string | null {
  if (value.length > MAX_PARAM || CONTROL.test(value)) return 'is not a value the rollups hold';
  switch (dimension) {
    case 'key':
      return null;
    case 'status':
      return /^[1-5](xx|\d\d)$/.test(value) ? null : 'must be a status class (5xx) or a code (503)';
    case 'method':
      return /^[A-Za-z]{1,16}$/.test(value) ? null : 'must be an HTTP method';
    case 'path':
      return value.startsWith('/') || value === OTHER_PATHS_VALUE
        ? null
        : 'must be a path starting with /';
  }
}

/**
 * Said wherever paths are broken down: the worker files templated paths
 * (ADR-0012 §5, amended 2026-09-23), and rows written before that stay raw,
 * so one endpoint can show twice across the change until they age out.
 */
export const PATH_TEMPLATE_NOTE =
  'Paths are templated at ingest: named groups in the API’s path rules first, then ids, UUIDs, hex and long tokens (/users/42 → /users/{id}). Traffic ingested before templating was added keeps its raw paths until retention prunes it.';

/** The value the ingest worker folds paths past its per-batch cap into (ADR-0012 §5). */
export const OTHER_PATHS_VALUE = '(other)';

/**
 * The breakdowns the rollups can answer for a selection:
 * - with no focus, every dimension (`api` only across APIs; `key` only with
 *   `keys:read`);
 * - with a focus, only by API (the focus rows grouped by their API), plus,
 *   for a status class, the codes in that class.
 */
export function allowedBreakdowns(
  selection: { apiId: string | null; focus: DrillFocus | null },
  options: { keys: boolean; source?: TrafficSource },
): BreakdownDimension[] {
  const { apiId, focus } = selection;
  return BREAKDOWN_DIMENSIONS.filter((dimension) => {
    if (options.source === 'prometheus' && !PROMETHEUS_DIMENSIONS.includes(dimension)) return false;
    if (dimension === 'api') return apiId === null;
    if (focus === null) return dimension !== 'key' || options.keys;
    return dimension === 'status' && focus.dimension === 'status' && isStatusClass(focus.value);
  });
}

function isStatusClass(value: string): boolean {
  return /^[1-5]xx$/.test(value);
}

/**
 * Reads the drill-down from `/analytics` search params. `api` names an API;
 * one of `key`, `status`, `method` and `path` narrows further; `by` picks
 * the breakdown. Without `keys:read`, `key` and `by=key` are ignored. From
 * Prometheus, only `api` and `status` apply (ADR-0015 §4); the rest are
 * ignored with a note.
 */
export function parseDrill(
  params: SearchParams,
  options: { keys: boolean; source?: TrafficSource },
): Drill {
  const notes: string[] = [];
  const api = first(params.api);
  let apiId: string | null = null;
  if (api !== undefined && api !== '') {
    if (api.length > MAX_PARAM || CONTROL.test(api)) notes.push('api: not an API id; ignored.');
    else apiId = api;
  }

  let focus: DrillFocus | null = null;
  for (const dimension of FOCUS_DIMENSIONS) {
    const value = first(params[dimension]);
    // `key=` is the keyless requests; an empty value means nothing elsewhere.
    if (value === undefined || (value === '' && dimension !== 'key')) continue;
    if (dimension === 'key' && !options.keys) {
      notes.push('key: needs the keys:read permission; ignored.');
      continue;
    }
    if (options.source === 'prometheus' && !PROMETHEUS_DIMENSIONS.includes(dimension)) {
      notes.push(
        `${dimension}: ignored, g2way's Prometheus metrics carry no ${dimension} label. Switch to the rollups to narrow by it.`,
      );
      continue;
    }
    const problem = focusProblem(dimension, value);
    if (problem !== null) {
      notes.push(`${dimension}: ${problem}; ignored.`);
    } else if (focus !== null) {
      notes.push(
        `${dimension}: ignored, the selection already narrows by ${focus.dimension}. The rollups store one dimension per row, so two cannot be combined.`,
      );
    } else {
      focus = { dimension, value };
    }
  }

  const allowed = allowedBreakdowns({ apiId, focus }, options);
  const requested = first(params.by);
  let by: BreakdownDimension | null = allowed[0] ?? null;
  if (requested !== undefined && requested !== '') {
    const match = allowed.find((dimension) => dimension === requested);
    if (match !== undefined) by = match;
    else notes.push(`by=${requested}: not a breakdown this selection can answer; ignored.`);
  }
  return { apiId, focus, by, notes };
}

/** A focus as the rollup rows it selects. */
export function focusSelection(focus: DrillFocus | null): {
  dimension?: RollupDimension;
  value?: string;
  statusClass?: StatusClass;
} {
  if (focus === null) return {};
  if (focus.dimension === 'status' && isStatusClass(focus.value)) {
    return { dimension: 'status', statusClass: Number(focus.value[0]) as StatusClass };
  }
  return { dimension: focus.dimension, value: focus.value };
}

/**
 * The rows a breakdown reads and how it groups them. Under a focus the rows
 * are the focus's own (a key's rows, grouped by API); otherwise they are the
 * breakdown dimension's rows. Status breaks down by class, or by code inside
 * a class focus.
 */
export function breakdownPlan(
  drill: Pick<Drill, 'focus'>,
  by: BreakdownDimension,
): { selection: ReturnType<typeof focusSelection>; group: BreakdownGroup } {
  if (by === 'api') {
    const selection = focusSelection(drill.focus);
    return { selection: { dimension: 'api', ...selection }, group: 'api' };
  }
  if (by === 'status' && drill.focus?.dimension === 'status') {
    return { selection: focusSelection(drill.focus), group: 'value' };
  }
  return { selection: { dimension: by }, group: by === 'status' ? 'class' : 'value' };
}

/** How one breakdown group reads, as the focus it would drill into. */
export function groupFocus(
  by: Exclude<BreakdownDimension, 'api'>,
  group: BreakdownGroup,
  value: string,
): DrillFocus {
  return { dimension: by, value: group === 'class' ? `${value}xx` : value };
}

export type DrillState = {
  /** A fixed range, relative to now, or a custom window, absolute (`?from=&to=`). */
  range: TrafficRangeId | CustomWindow;
  /** Absent means the rollups, the default source. */
  source?: TrafficSource;
  apiId: string | null;
  focus: DrillFocus | null;
  by: BreakdownDimension | null;
};

/**
 * A drill-down state as search parameters, in a fixed order: `range` (or
 * `from` and `to` for a custom window), `source`, `api`, the focus, `by`.
 */
export function drillParams(state: DrillState): [string, string][] {
  const params: [string, string][] =
    typeof state.range === 'string'
      ? [['range', state.range]]
      : [
          ['from', formatUtcMinute(state.range.from)],
          ['to', formatUtcMinute(state.range.to)],
        ];
  return [...params, ...selectionParams(state)];
}

/**
 * Everything but the range: what a custom-range form carries in hidden
 * inputs, so submitting new dates keeps the source and the drill-down.
 */
export function selectionParams(state: Omit<DrillState, 'range'>): [string, string][] {
  const params: [string, string][] = [];
  if (state.source === 'prometheus') params.push(['source', 'prometheus']);
  if (state.apiId !== null) params.push(['api', state.apiId]);
  if (state.focus !== null) params.push([state.focus.dimension, state.focus.value]);
  if (state.by !== null) params.push(['by', state.by]);
  return params;
}

/**
 * The CSV export of a view (`GET /api/analytics/export`, ADR-0013 §8): the
 * table first, then the view's own parameters.
 */
export function exportHref(state: DrillState, table: 'series' | 'breakdown'): string {
  const params = new URLSearchParams([['table', table], ...drillParams(state)]);
  return `/api/analytics/export?${params.toString()}`;
}

/** The `/analytics` URL for a drill-down state; parameters in a fixed order. */
export function drillHref(state: DrillState): string {
  return `/analytics?${new URLSearchParams(drillParams(state)).toString()}`;
}

/**
 * The same view from `source`: the range kept where the source offers it
 * (else the default; a custom window is always kept, and checked again), and
 * a focus or breakdown that source cannot answer dropped rather than left
 * for `parseDrill` to note.
 */
export function sourceHref(
  state: DrillState,
  source: TrafficSource,
  hourRetentionDays?: number,
): string {
  const range =
    typeof state.range !== 'string' || offersRange(state.range, source, hourRetentionDays)
      ? state.range
      : DEFAULT_TRAFFIC_RANGE;
  const focus =
    source === 'prometheus' &&
    state.focus !== null &&
    !PROMETHEUS_DIMENSIONS.includes(state.focus.dimension)
      ? null
      : state.focus;
  const allowed = allowedBreakdowns({ apiId: state.apiId, focus }, { keys: true, source });
  const by = state.by !== null && allowed.includes(state.by) ? state.by : null;
  return drillHref({ range, source, apiId: state.apiId, focus, by });
}

/**
 * The href of every range the state's source offers (given the rollups' hour
 * retention, `offersRange`), with the rest of the drill-down kept.
 */
export function rangeHrefs(
  state: Omit<DrillState, 'range'>,
  hourRetentionDays?: number,
): Partial<Record<TrafficRangeId, string>> {
  return Object.fromEntries(
    rangesFor(state.source ?? 'rollups', hourRetentionDays).map((range) => [
      range,
      drillHref({ ...state, range }),
    ]),
  );
}

/** `total` minus `part`, counter by counter (never below 0). The maximum stays the total's: an upper bound. */
export function subtractBucket(
  total: TrafficBucket,
  parts: readonly TrafficBucket[],
): TrafficBucket {
  const rest = { ...total };
  for (const name of TRAFFIC_COUNTERS) {
    rest[name] = Math.max(0, total[name] - parts.reduce((sum, part) => sum + part[name], 0));
  }
  return rest;
}

/** One line of a breakdown chart: plain numbers, ready for `TimeSeriesChart`. */
export type BreakdownSeries = { label: string; slot: 1 | 2 | 3; values: number[] };

/**
 * Requests per second per step for the busiest groups, as at most three
 * series (ADR-0013 §2): each of up to three groups when they account for
 * all traffic, else the two busiest and "Everything else" (the total minus
 * those two), so the lines always add up to the total.
 */
export function breakdownSeries(
  range: TrafficRange,
  now: number,
  total: readonly TrafficBucket[],
  groups: readonly { label: string; buckets: readonly TrafficBucket[] }[],
): BreakdownSeries[] {
  const window = trafficWindow(range, now);
  const totals = resample(total, window);
  const seconds = totals.map((step) => elapsedSeconds(step.start, window.stepMs, now));
  const lines = groups.map((group) => ({
    label: group.label,
    steps: resample(group.buckets, window),
  }));
  const sum = (steps: TrafficBucket[]) => steps.reduce((n, step) => n + step.requests, 0);
  const all = sum(totals);
  const covered = lines.slice(0, 3).reduce((n, line) => n + sum(line.steps), 0);
  const whole = lines.length <= 3 && covered >= all;
  const shown = whole ? lines : lines.slice(0, 2);
  const series: BreakdownSeries[] = shown.map((line, i) => ({
    label: line.label,
    slot: (i + 1) as 1 | 2 | 3,
    values: line.steps.map((step, j) => step.requests / seconds[j]),
  }));
  if (!whole) {
    series.push({
      label: 'Everything else',
      slot: (shown.length + 1) as 1 | 2 | 3,
      values: totals.map((step, j) => {
        const rest = step.requests - shown.reduce((n, line) => n + line.steps[j].requests, 0);
        return Math.max(0, rest) / seconds[j];
      }),
    });
  }
  return series;
}

/** The window totals of `buckets` as one bucket. */
export function totalOf(buckets: readonly TrafficBucket[], start: number): TrafficBucket {
  const total = emptyBucket(start);
  for (const bucket of buckets) addBucket(total, bucket);
  return total;
}

/** How a breakdown group or a focus value is shown. */
export type GroupDisplay = {
  label: string;
  /** A second, quieter line: the short key hash under a key's name, or what a placeholder means. */
  detail: string | null;
  /** Ids, hashes and paths are set in monospace. */
  mono: boolean;
};

/**
 * Display text for one value of a dimension. A key shows its dashboard label,
 * else the alias the gateway recorded, else its short hash, which the keys
 * pages show too (ADR-0010: a hash is an identifier, not a credential).
 */
export function describeValue(
  dimension: BreakdownDimension,
  value: string,
  names: { keyLabel?: string | null; alias?: string | null; shortHash: (hash: string) => string },
): GroupDisplay {
  switch (dimension) {
    case 'key': {
      if (value === '') return { label: 'No key', detail: 'keyless requests', mono: false };
      const name = names.keyLabel ?? names.alias ?? null;
      return name === null
        ? { label: names.shortHash(value), detail: null, mono: true }
        : { label: name, detail: names.shortHash(value), mono: false };
    }
    case 'path':
      return value === OTHER_PATHS_VALUE
        ? { label: 'Other paths', detail: 'past the 200 busiest per batch', mono: false }
        : { label: value, detail: null, mono: true };
    case 'api':
      return { label: value, detail: null, mono: true };
    case 'status':
    case 'method':
      return { label: value, detail: null, mono: false };
  }
}

/** The `/analytics` link other pages use for one API's or one key's traffic, at the default range. */
export function trafficHref(target: { api: string } | { key: string }): string {
  return drillHref({
    range: DEFAULT_TRAFFIC_RANGE,
    apiId: 'api' in target ? target.api : null,
    focus: 'key' in target ? { dimension: 'key', value: target.key } : null,
    by: null,
  });
}
