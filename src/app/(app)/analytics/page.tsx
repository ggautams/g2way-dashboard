import type { Metadata } from 'next';
import Link from 'next/link';
import {
  BreakdownPanel,
  type BreakdownItem,
  type BreakdownView,
} from '@/components/analytics/breakdown-panel';
import { DrillBar, type DrillChip } from '@/components/analytics/drill-bar';
import { IngestHealthPanel } from '@/components/analytics/ingest-health';
import { TrafficPanel, formatStep } from '@/components/analytics/traffic-panel';
import {
  DIMENSION_LABELS,
  allowedBreakdowns,
  breakdownPlan,
  breakdownSeries,
  describeValue,
  drillHref,
  focusSelection,
  groupFocus,
  parseDrill,
  rangeHrefs,
  sourceHref,
  subtractBucket,
  totalOf,
  type BreakdownDimension,
  type Drill,
  type DrillState,
} from '@/lib/analytics/drill';
import { loadIngestHealth } from '@/lib/analytics/load-health';
import { PrometheusError, loadPrometheusTraffic } from '@/lib/analytics/prometheus';
import { breakdownTotals, type PromGrouping } from '@/lib/analytics/promql';
import { liveHref } from '@/lib/analytics/tail';
import {
  TRAFFIC_RANGE_IDS,
  elapsedSeconds,
  parseTrafficRange,
  parseTrafficSource,
  summarise,
  trafficSeries,
  trafficWindow,
  type SummaryOptions,
  type TrafficBucket,
  type TrafficRange,
  type TrafficSource,
} from '@/lib/analytics/traffic';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import {
  queryBreakdown,
  queryBreakdownBuckets,
  queryTrafficBuckets,
  type BreakdownRow,
} from '@/lib/db/analytics';
import { listKeyMetadata } from '@/lib/db/key-metadata';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  resolveEnvironment,
  type GatewayTarget,
  type PrometheusSource,
} from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { shortHash } from '@/lib/keys/session';

export const metadata: Metadata = { title: 'Analytics' };

/**
 * Traffic for the selected environment, from the ingest worker's rollups
 * (ADR-0012). The ingest health panel comes first, so an empty chart always
 * says why; the traffic charts follow, over a fixed range (`?range=`).
 *
 * Drill-down (`lib/analytics/drill.ts`): `?api=` narrows to one API, one of
 * `?key=`, `?status=` (class `5xx` or code), `?method=` and `?path=` narrows
 * further, and `?by=` picks the breakdown below the charts. Key drill-down
 * needs `keys:read` as well; links to API and key pages appear only for roles
 * that may open them.
 *
 * Where the environment names a Prometheus, `?source=prometheus` reads the
 * gateway's request-duration metric from it instead (ADR-0015): longer
 * ranges, API and status drill-down only.
 */
export default async function AnalyticsPage({ searchParams }: PageProps<'/analytics'>) {
  const user = await requirePermission('gateway:read');
  const params = await searchParams;
  const roles = { keys: can(user.role, 'keys:read'), apis: can(user.role, 'apis:read') };
  const inspect = can(user.role, 'analytics:inspect');

  let target: GatewayTarget;
  try {
    target = resolveEnvironment(await selectedEnvironmentId());
  } catch (error) {
    if (error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError) {
      return (
        <Page>
          <section
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm"
          >
            <p className="mb-1 font-medium text-danger">Cannot pick a gateway</p>
            <p className="font-mono text-xs">{error.message}</p>
          </section>
        </Page>
      );
    }
    throw error;
  }

  const prometheus = target.prometheus;
  const sourceParam = parseTrafficSource(first(params.source), prometheus !== null);
  const source = sourceParam.source;
  const range = parseTrafficRange(first(params.range), source);
  const drill = parseDrill(params, { keys: roles.keys, source });
  const notes = [
    ...(sourceParam.note === null ? [] : [sourceParam.note]),
    ...rangeNotes(first(params.range), range),
    ...drill.notes,
  ];

  // Loaded under either source: it is one small read, and it fixes `now`.
  const health = await loadIngestHealth(target);
  const now = health.now;
  const ingest = source === 'rollups' ? health : null;
  const reader =
    source === 'prometheus' && prometheus !== null
      ? prometheusReader(prometheus, range, drill, now)
      : rollupReader(target, range, drill, now);
  const state: DrillState = {
    range: range.id,
    ...(source === 'prometheus' ? { source } : {}),
    apiId: drill.apiId,
    focus: drill.focus,
    by: drill.by,
  };
  const keyLabels = roles.keys ? await loadKeyLabels(target, drill) : new Map<string, string>();
  const sourceHrefs =
    prometheus === null
      ? null
      : {
          rollups: sourceHref(state, 'rollups'),
          prometheus: sourceHref(state, 'prometheus'),
        };

  let loaded;
  try {
    const buckets = await reader.total();
    const traffic = trafficSeries(range, buckets, now, reader.options);
    const breakdown =
      drill.by === null
        ? null
        : await loadBreakdown(target, reader, range, drill, drill.by, buckets, now, {
            roles,
            state,
          });
    loaded = { traffic, breakdown, error: null };
  } catch (error) {
    if (!(error instanceof PrometheusError)) throw error;
    loaded = { traffic: null, breakdown: null, error: error.message };
  }
  const { traffic, breakdown } = loaded;

  return (
    <Page environment={target.label} source={source}>
      {ingest === null ? (
        <p className="text-sm text-muted">
          Reading the gateway&apos;s <code className="font-mono">http.server.request.duration</code>{' '}
          metric from this environment&apos;s Prometheus
          {prometheus?.selector ? (
            <>
              {' '}
              (series matching <code className="font-mono">{prometheus.selector}</code>)
            </>
          ) : null}
          . Key, method and path are not in the metric&apos;s labels; the rollups have them.
        </p>
      ) : (
        <IngestHealthPanel
          health={ingest.health}
          configProblems={ingest.configProblems}
          now={now}
        />
      )}
      <DrillBar
        chips={drillChips(drill, state, roles, keyLabels)}
        notes={notes}
        clearHref={drillHref({ ...state, apiId: null, focus: null, by: null })}
      />
      {inspect && (
        <p className="text-sm">
          <Link className="underline" href={liveHref({ apiId: drill.apiId, focus: drill.focus })}>
            Live requests for this selection
          </Link>{' '}
          <span className="text-muted">
            (the newest individual requests, refreshed as they arrive)
          </span>
        </p>
      )}
      {traffic === null ? (
        <section
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm"
        >
          <p className="mb-1 font-medium text-danger">Prometheus query failed</p>
          <p className="font-mono text-xs">{loaded.error}</p>
          {sourceHrefs !== null && (
            <p className="mt-2">
              <Link className="underline" href={sourceHrefs.rollups}>
                Show the rollups instead
              </Link>
            </p>
          )}
        </section>
      ) : (
        <TrafficPanel
          traffic={traffic}
          rangeHrefs={rangeHrefs(state)}
          scoped={drill.apiId !== null || drill.focus !== null}
          source={source}
          sourceHrefs={sourceHrefs}
          warnings={reader.warnings}
        />
      )}
      {traffic === null ? null : breakdown === null ? (
        drill.focus !== null &&
        source === 'rollups' && (
          <p className="text-sm text-muted">
            No breakdown: the rollups keep one dimension per row, always with its API, so traffic
            narrowed to an API and a {DIMENSION_LABELS[drill.focus.dimension].toLowerCase()} cannot
            be split any further.
          </p>
        )
      ) : (
        <BreakdownPanel view={breakdown} />
      )}
    </Page>
  );
}

/** Where a view's buckets come from: the rollups or Prometheus, behind one shape. */
type TrafficReader = {
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

function rollupReader(
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
function prometheusReader(
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

/** The busiest groups shown in the table; the chart draws at most three lines (ADR-0013 §2). */
const BREAKDOWN_ROWS = 10;

type Roles = { keys: boolean; apis: boolean };

/**
 * The breakdown of the selection by `by`: the busiest groups with their
 * totals, the lines of the top three, and "Everything else" when more exist.
 * The selection's own buckets are the total every breakdown sums to.
 */
async function loadBreakdown(
  target: GatewayTarget,
  reader: TrafficReader,
  range: TrafficRange,
  drill: Drill,
  by: BreakdownDimension,
  total: readonly TrafficBucket[],
  now: number,
  context: { roles: Roles; state: DrillState },
): Promise<BreakdownView> {
  const { roles, state } = context;
  const window = trafficWindow(range, now);
  const plan = breakdownPlan(drill, by);
  const { rows, lines } = await reader.breakdown(by, BREAKDOWN_ROWS);
  const top = rows.slice(0, 3);
  const keyLabels =
    by === 'key'
      ? await listKeyMetadata(
          getDatabase(),
          getOrgId(),
          target.id,
          rows.map((row) => row.group),
        )
      : new Map<string, { label: string | null }>();

  const seconds = elapsedSeconds(window.from, window.to - window.from, now);
  const all = totalOf(total, window.from);
  const display = (group: string, alias: string | null) =>
    describeValue(by, plan.group === 'class' ? `${group}xx` : group, {
      keyLabel: keyLabels.get(group)?.label ?? null,
      alias,
      shortHash,
    });
  const items: BreakdownItem[] = rows.map((row) => {
    const bucket: TrafficBucket = { ...row, start: window.from };
    return {
      id: `group:${row.group}`,
      ...display(row.group, row.label),
      requests: row.requests,
      share: all.requests === 0 ? 0 : row.requests / all.requests,
      summary: summarise(bucket, seconds, reader.options),
      drillHref: drillHref(
        by === 'api'
          ? { ...state, apiId: row.group, by: null }
          : { ...state, focus: groupFocus(by, plan.group, row.group), by: null },
      ),
      page: groupPage(by, row.group, roles),
    };
  });
  const rest = subtractBucket(
    all,
    rows.map((row) => ({ ...row, start: window.from })),
  );
  if (rest.requests > 0) {
    items.push({
      id: 'rest',
      label: 'Everything else',
      detail: null,
      mono: false,
      requests: rest.requests,
      share: all.requests === 0 ? 0 : rest.requests / all.requests,
      summary: summarise(rest, seconds, reader.options),
      drillHref: null,
      page: null,
    });
  }

  const series = breakdownSeries(
    range,
    now,
    total,
    top.map((row) => ({
      label: display(row.group, row.label).label,
      buckets: lines.get(row.group) ?? [],
    })),
  );
  const starts = Array.from({ length: window.points }, (_, i) => window.from + i * window.stepMs);
  return {
    by,
    tabs: allowedBreakdowns(drill, { ...roles, source: state.source }).map((dimension) => ({
      dimension,
      href: drillHref({ ...state, by: dimension }),
    })),
    groupHeading: groupHeading(by, plan.group),
    items,
    chart: { starts, stepMs: window.stepMs, from: window.from, to: window.to, series },
    rangeLabel: range.label,
    step: formatStep(range.stepSeconds),
  };
}

function groupHeading(by: BreakdownDimension, group: 'value' | 'api' | 'class'): string {
  if (by === 'status') return group === 'class' ? 'Status class' : 'Status code';
  return DIMENSION_LABELS[by];
}

/** The API's or key's own page, where the role may open it. */
function groupPage(
  dimension: BreakdownDimension | 'status',
  value: string,
  roles: Roles,
): { href: string; label: string } | null {
  if (dimension === 'api' && roles.apis) {
    return { href: `/apis/view/${encodeURIComponent(value)}`, label: 'API page' };
  }
  if (dimension === 'key' && roles.keys && value !== '') {
    return { href: `/keys/view/${encodeURIComponent(value)}`, label: 'Key page' };
  }
  return null;
}

/** The dashboard label of the key the selection narrows to, if any. */
async function loadKeyLabels(target: GatewayTarget, drill: Drill): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (drill.focus?.dimension !== 'key' || drill.focus.value === '') return out;
  const found = await listKeyMetadata(getDatabase(), getOrgId(), target.id, [drill.focus.value]);
  for (const [hash, row] of found) if (row.label !== null) out.set(hash, row.label);
  return out;
}

/** The selection as removable chips: the API, then the focus. */
function drillChips(
  drill: Drill,
  state: DrillState,
  roles: Roles,
  keyLabels: Map<string, string>,
): DrillChip[] {
  const chips: DrillChip[] = [];
  if (drill.apiId !== null) {
    chips.push({
      dimension: 'API',
      ...describeValue('api', drill.apiId, { shortHash }),
      removeHref: drillHref({ ...state, apiId: null, by: null }),
      page: groupPage('api', drill.apiId, roles),
    });
  }
  if (drill.focus !== null) {
    const { dimension, value } = drill.focus;
    chips.push({
      dimension: DIMENSION_LABELS[dimension],
      ...describeValue(dimension, value, { keyLabel: keyLabels.get(value) ?? null, shortHash }),
      removeHref: drillHref({ ...state, focus: null, by: null }),
      page: groupPage(dimension, value, roles),
    });
  }
  return chips;
}

function Page({
  children,
  environment,
  source = 'rollups',
}: {
  children: React.ReactNode;
  environment?: string;
  source?: TrafficSource;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted">
          Traffic, errors and latency
          {environment && (
            <>
              {' '}
              for <span className="font-medium text-foreground">{environment}</span>
            </>
          )}
          {source === 'prometheus'
            ? ', from the gateway’s metrics in Prometheus.'
            : ', from the gateway’s analytics records.'}
        </p>
      </header>
      {children}
    </div>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Why a `?range=` naming a real range was not used: the source does not offer it. */
function rangeNotes(requested: string | undefined, range: TrafficRange): string[] {
  if (requested === undefined || requested === range.id) return [];
  if (!TRAFFIC_RANGE_IDS.some((id) => id === requested)) return [];
  return [
    `range=${requested}: offered only from Prometheus (ADR-0015); showing ${range.label.toLowerCase()}.`,
  ];
}
