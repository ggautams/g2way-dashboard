import 'server-only';

import { getDatabase } from '@/lib/db';
import {
  queryBreakdown,
  queryBreakdownBuckets,
  queryTrafficBuckets,
  type BreakdownRow,
} from '@/lib/db/analytics';
import { getOrgId, type GatewayTarget, type PrometheusSource } from '@/lib/g2/environments';
import { customRange, readCustomWindow, type CustomWindow } from './custom-range';
import {
  breakdownPlan,
  focusSelection,
  parseDrill,
  type BreakdownDimension,
  type Drill,
  type DrillState,
} from './drill';
import { rollupRetention } from './load-health';
import { retainedRange, type RollupRetention } from './retention';
import { loadPrometheusTraffic } from './prometheus';
import { breakdownTotals, type PromGrouping } from './promql';
import {
  TRAFFIC_RANGE_IDS,
  parseTrafficRange,
  parseTrafficSource,
  rangePhrase,
  trafficWindow,
  type FixedTrafficRange,
  type SummaryOptions,
  type TrafficBucket,
  type TrafficRange,
  type TrafficSource,
} from './traffic';

/**
 * What an `/analytics` URL selects, and where its buckets come from: shared
 * by the page and the CSV export (`GET /api/analytics/export`), so a download
 * is exactly the view on screen. Server-only: the readers hold the database
 * and the Prometheus credentials (ADR-0015 §5).
 */

type SearchParams = Record<string, string | string[] | undefined>;

export type ResolvedView = {
  source: TrafficSource;
  /**
   * The fixed range asked for (or the default), as retention lets the source
   * answer it (`retainedRange`): shown when a custom window is refused.
   */
  fixed: FixedTrafficRange;
  custom: ReturnType<typeof resolveCustom>;
  /** The range in view: the custom window's, else the fixed one. */
  range: TrafficRange;
  drill: Drill;
  state: DrillState;
  /** Every ignored or adjusted parameter, with the reason. */
  notes: string[];
  reader: TrafficReader;
  /** This server's rollup retention: which ranges the rollups offer (`rangesFor`). */
  retention: RollupRetention;
};

/**
 * Reads source, range and drill-down from search params at `now`. `keys` is
 * whether the role holds `keys:read`: without it, key focus and breakdown are
 * ignored with a note (`parseDrill`).
 */
export function resolveView(
  target: GatewayTarget,
  params: SearchParams,
  options: { keys: boolean; now: number },
): ResolvedView {
  const { now } = options;
  const prometheus = target.prometheus;
  const sourceParam = parseTrafficSource(first(params.source), prometheus !== null);
  const source = sourceParam.source;
  const drill = parseDrill(params, { keys: options.keys, source });
  const retention = rollupRetention();
  const retained = retainedRange(
    parseTrafficRange(first(params.range), source, retention.hourRetentionDays),
    { source, now, ...retention },
  );
  const fixed = retained.range;
  const custom = resolveCustom(first(params.from), first(params.to), source, now, retention);
  const range = custom.range ?? fixed;
  const notes = [
    ...(sourceParam.note === null ? [] : [sourceParam.note]),
    ...(custom.range === null
      ? [...rangeNotes(first(params.range), fixed, retention), ...retained.notes]
      : []),
    ...custom.notes,
    ...(custom.problem === null ? [] : [`${custom.problem} Showing ${rangePhrase(fixed)}.`]),
    ...drill.notes,
  ];
  const reader =
    source === 'prometheus' && prometheus !== null
      ? prometheusReader(prometheus, range, drill, now)
      : rollupReader(target, range, drill, now);
  const state: DrillState = {
    range: custom.window ?? fixed.id,
    ...(source === 'prometheus' ? { source } : {}),
    apiId: drill.apiId,
    focus: drill.focus,
    by: drill.by,
  };
  return { source, fixed, custom, range, drill, state, notes, reader, retention };
}

/** Where a view's buckets come from: the rollups or Prometheus, behind one shape. */
export type TrafficReader = {
  /** The selection's source buckets over the range's window. */
  total(): Promise<TrafficBucket[]>;
  /** The busiest `limit` groups by `by`, and the buckets of at least the top three. */
  breakdown(
    by: BreakdownDimension,
    limit: number,
  ): Promise<{ rows: BreakdownRow[]; lines: Map<string, TrafficBucket[]> }>;
  options: SummaryOptions;
  /** Prometheus's query warnings, filled as queries run. */
  warnings: string[];
};

export function rollupReader(
  target: GatewayTarget,
  range: TrafficRange,
  drill: Drill,
  now: number,
): TrafficReader {
  const { from, to } = trafficWindow(range, now);
  const base = {
    environment: target.id,
    bucketSeconds: range.sourceSeconds,
    from,
    to,
    ...(drill.apiId === null ? {} : { apiId: drill.apiId }),
  };
  return {
    options: {},
    warnings: [],
    total: () =>
      queryTrafficBuckets(getDatabase(), getOrgId(), { ...base, ...focusSelection(drill.focus) }),
    async breakdown(by, limit) {
      const plan = breakdownPlan(drill, by);
      const selection = { ...base, ...plan.selection };
      const db = getDatabase();
      const orgId = getOrgId();
      const rows = await queryBreakdown(db, orgId, { ...selection, group: plan.group, limit });
      const lines = await queryBreakdownBuckets(db, orgId, {
        ...selection,
        group: plan.group,
        groups: rows.slice(0, 3).map((row) => row.group),
      });
      return { rows, lines };
    },
  };
}

/** The same shape from Prometheus (ADR-0015 §3): API and status only. */
export function prometheusReader(
  source: PrometheusSource,
  range: TrafficRange,
  drill: Drill,
  now: number,
): TrafficReader {
  const { from, to } = trafficWindow(range, now);
  const warnings: string[] = [];
  const load = async (grouping: PromGrouping) => {
    const result = await loadPrometheusTraffic(source, {
      orgId: getOrgId(),
      apiId: drill.apiId,
      status: drill.focus?.dimension === 'status' ? drill.focus.value : null,
      from,
      to,
      stepSeconds: range.stepSeconds,
      grouping,
    });
    for (const warning of result.warnings) if (!warnings.includes(warning)) warnings.push(warning);
    return result.groups;
  };
  return {
    options: { exactMax: false },
    warnings,
    total: async () => (await load(null)).get('') ?? [],
    async breakdown(by, limit) {
      const { group } = breakdownPlan(drill, by);
      const groups = await load({ group, dimension: by === 'api' ? 'api' : 'status' });
      return { rows: breakdownTotals(groups, limit), lines: groups };
    },
  };
}

/** A custom window, if the URL asks for one: the range it reads as, or why it cannot. */
export function resolveCustom(
  from: string | undefined,
  to: string | undefined,
  source: TrafficSource,
  now: number,
  retention: RollupRetention,
): {
  window: CustomWindow | null;
  range: TrafficRange | null;
  notes: string[];
  problem: string | null;
  input: { from: string; to: string } | null;
} {
  const none = { window: null, range: null, notes: [], problem: null, input: null };
  const read = readCustomWindow(from, to);
  if (read === null) return none;
  const input = { from: from ?? '', to: to ?? '' };
  if ('problem' in read) return { ...none, problem: read.problem, input };
  const resolved = customRange(read.window, { source, now, ...retention });
  if ('problem' in resolved) return { ...none, problem: resolved.problem, input };
  return {
    window: read.window,
    range: resolved.range,
    notes: resolved.notes,
    problem: null,
    input,
  };
}

/**
 * Why a `?range=` naming a real range was not used: the rollups do not offer
 * it, since their hour rows are not kept that long (Prometheus offers every
 * range).
 */
function rangeNotes(
  requested: string | undefined,
  range: TrafficRange,
  retention: RollupRetention,
): string[] {
  if (requested === undefined || requested === range.id) return [];
  if (!TRAFFIC_RANGE_IDS.some((id) => id === requested)) return [];
  return [
    `range=${requested}: hour rollups are kept ${retention.hourRetentionDays} days (G2_ANALYTICS_HOUR_RETENTION_DAYS), too few for it, so it is offered only from Prometheus (ADR-0015); showing ${rangePhrase(range)}.`,
  ];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
