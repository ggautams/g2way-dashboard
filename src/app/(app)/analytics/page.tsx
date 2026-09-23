import type { Metadata } from 'next';
import {
  BreakdownPanel,
  type BreakdownItem,
  type BreakdownView,
} from '@/components/analytics/breakdown-panel';
import { DrillBar, type DrillChip } from '@/components/analytics/drill-bar';
import { IngestHealthPanel } from '@/components/analytics/ingest-health';
import { TrafficPanel, formatStep } from '@/components/analytics/traffic-panel';
import { IngestConfigError, parseIngestConfig } from '@/lib/analytics/config';
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
  subtractBucket,
  totalOf,
  type BreakdownDimension,
  type Drill,
  type DrillState,
} from '@/lib/analytics/drill';
import { ingestHealth } from '@/lib/analytics/health';
import {
  elapsedSeconds,
  parseTrafficRange,
  summarise,
  trafficSeries,
  trafficWindow,
  type TrafficBucket,
  type TrafficRange,
} from '@/lib/analytics/traffic';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import {
  getIngestState,
  queryBreakdown,
  queryBreakdownBuckets,
  queryTrafficBuckets,
} from '@/lib/db/analytics';
import { listKeyMetadata } from '@/lib/db/key-metadata';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  resolveEnvironment,
  type GatewayTarget,
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
 */
export default async function AnalyticsPage({ searchParams }: PageProps<'/analytics'>) {
  const user = await requirePermission('gateway:read');
  const params = await searchParams;
  const range = parseTrafficRange(params.range);
  const roles = { keys: can(user.role, 'keys:read'), apis: can(user.role, 'apis:read') };
  const drill = parseDrill(params, { keys: roles.keys });

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

  const { health, configProblems, now } = await loadIngestHealth(target);
  const { traffic, buckets } = await loadTraffic(target, range, drill, now);
  const state: DrillState = {
    range: range.id,
    apiId: drill.apiId,
    focus: drill.focus,
    by: drill.by,
  };
  const keyLabels = roles.keys ? await loadKeyLabels(target, drill) : new Map<string, string>();
  const breakdown =
    drill.by === null
      ? null
      : await loadBreakdown(target, range, drill, drill.by, buckets, now, { roles, state });

  return (
    <Page environment={target.label}>
      <IngestHealthPanel health={health} configProblems={configProblems} now={now} />
      <DrillBar
        chips={drillChips(drill, state, roles, keyLabels)}
        notes={drill.notes}
        clearHref={drillHref({ range: range.id, apiId: null, focus: null, by: null })}
      />
      <TrafficPanel
        traffic={traffic}
        rangeHrefs={rangeHrefs(state)}
        scoped={drill.apiId !== null || drill.focus !== null}
      />
      {breakdown === null ? (
        drill.focus !== null && (
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

/** The environment's ingest health, and the time it was read (for the "ago" labels). */
async function loadIngestHealth(target: GatewayTarget) {
  let workerInServer = false;
  let configProblems: readonly string[] = [];
  try {
    workerInServer = parseIngestConfig(process.env).inServer;
  } catch (error) {
    if (!(error instanceof IngestConfigError)) throw error;
    configProblems = error.problems;
  }
  const redisConfigured = target.redisUrl !== null;
  const state = redisConfigured
    ? await getIngestState(getDatabase(), getOrgId(), target.id)
    : undefined;
  const now = Date.now();
  const health = ingestHealth({ redisConfigured, workerInServer, state, now });
  return { health, configProblems, now };
}

/** The range's chart series for the selection, and the source buckets they came from. */
async function loadTraffic(target: GatewayTarget, range: TrafficRange, drill: Drill, now: number) {
  const { from, to } = trafficWindow(range, now);
  const buckets = await queryTrafficBuckets(getDatabase(), getOrgId(), {
    environment: target.id,
    bucketSeconds: range.sourceSeconds,
    from,
    to,
    ...(drill.apiId === null ? {} : { apiId: drill.apiId }),
    ...focusSelection(drill.focus),
  });
  return { traffic: trafficSeries(range, buckets, now), buckets };
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
  const selection = {
    environment: target.id,
    bucketSeconds: range.sourceSeconds,
    from: window.from,
    to: window.to,
    ...(drill.apiId === null ? {} : { apiId: drill.apiId }),
    ...plan.selection,
  };
  const db = getDatabase();
  const orgId = getOrgId();
  const rows = await queryBreakdown(db, orgId, {
    ...selection,
    group: plan.group,
    limit: BREAKDOWN_ROWS,
  });
  const top = rows.slice(0, 3);
  const lines = await queryBreakdownBuckets(db, orgId, {
    ...selection,
    group: plan.group,
    groups: top.map((row) => row.group),
  });
  const keyLabels =
    by === 'key'
      ? await listKeyMetadata(
          db,
          orgId,
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
      summary: summarise(bucket, seconds),
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
      summary: summarise(rest, seconds),
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
    tabs: allowedBreakdowns(drill, roles).map((dimension) => ({
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

function Page({ children, environment }: { children: React.ReactNode; environment?: string }) {
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
          , from the gateway&apos;s analytics records.
        </p>
      </header>
      {children}
    </div>
  );
}
