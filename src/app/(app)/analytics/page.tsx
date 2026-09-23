import type { Metadata } from 'next';
import Link from 'next/link';
import {
  BreakdownPanel,
  type BreakdownItem,
  type BreakdownView,
} from '@/components/analytics/breakdown-panel';
import { DrillBar, type DrillChip } from '@/components/analytics/drill-bar';
import { IngestHealthPanel } from '@/components/analytics/ingest-health';
import { SavedViewsPanel, type SavedViewItem } from '@/components/analytics/saved-views';
import {
  TrafficPanel,
  formatStep,
  type CustomRangeForm,
} from '@/components/analytics/traffic-panel';
import { formatUtcMinute } from '@/lib/analytics/custom-range';
import {
  DIMENSION_LABELS,
  allowedBreakdowns,
  breakdownPlan,
  breakdownSeries,
  describeValue,
  drillHref,
  drillParams,
  exportHref,
  groupFocus,
  rangeHrefs,
  selectionParams,
  sourceHref,
  subtractBucket,
  totalOf,
  type BreakdownDimension,
  type Drill,
  type DrillState,
} from '@/lib/analytics/drill';
import { loadIngestHealth } from '@/lib/analytics/load-health';
import { PrometheusError } from '@/lib/analytics/prometheus';
import { deleteViewAction, saveViewAction } from '@/lib/analytics/saved-view-actions';
import { describeViewQuery, viewHref } from '@/lib/analytics/saved-views';
import { liveHref } from '@/lib/analytics/tail';
import { resolveView, type ResolvedView, type TrafficReader } from '@/lib/analytics/view';
import {
  elapsedSeconds,
  rangePhrase,
  rangeWithin,
  summarise,
  trafficSeries,
  trafficWindow,
  type TrafficBucket,
  type TrafficRange,
  type TrafficSource,
} from '@/lib/analytics/traffic';
import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { getDatabase } from '@/lib/db';
import { listKeyMetadata } from '@/lib/db/key-metadata';
import { listSavedViews } from '@/lib/db/saved-views';
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
 *
 * Where the environment names a Prometheus, `?source=prometheus` reads the
 * gateway's request-duration metric from it instead (ADR-0015): longer
 * ranges, API and status drill-down only.
 *
 * `?from=` and `?to=` (UTC, `YYYY-MM-DDTHH:mm`) replace `?range=` with a
 * custom window (ADR-0013 §7); a window that cannot be shown says why, and
 * the fixed range is shown instead.
 *
 * Saved views (ADR-0016) are names for these URLs, listed per environment:
 * the shared ones, then the user's own.
 */
export default async function AnalyticsPage({ searchParams }: PageProps<'/analytics'>) {
  const user = await requirePermission('gateway:read');
  const params = await searchParams;
  const roles = { keys: can(user.role, 'keys:read'), apis: can(user.role, 'apis:read') };
  const inspect = can(user.role, 'analytics:inspect');
  const canShare = can(user.role, 'analytics:share');

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

  // Loaded under either source: it is one small read, and it fixes `now`.
  const health = await loadIngestHealth(target);
  const now = health.now;
  const view = resolveView(target, params, { keys: roles.keys, now });
  const { source, range, drill, state, notes, reader, custom, retention } = view;
  const ingest = source === 'rollups' ? health : null;
  const keyLabels = roles.keys ? await loadKeyLabels(target, drill) : new Map<string, string>();
  const currentQuery = new URLSearchParams(drillParams(state)).toString();
  const savedViews: SavedViewItem[] = (
    await listSavedViews(getDatabase(), getOrgId(), { environment: target.id, ownerId: user.id })
  ).map((view) => ({
    id: view.id,
    name: view.name,
    href: viewHref(view.query),
    summary: describeViewQuery(view.query, retention.hourRetentionDays),
    shared: view.shared,
    owner: view.ownerEmail,
    deletable: view.shared ? canShare : view.ownerId === user.id,
    current: view.query === currentQuery,
  }));
  const sourceHrefs =
    prometheus === null
      ? null
      : {
          rollups: sourceHref(state, 'rollups', retention.hourRetentionDays),
          prometheus: sourceHref(state, 'prometheus', retention.hourRetentionDays),
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
      <SavedViewsPanel
        items={savedViews}
        environment={target.id}
        query={currentQuery}
        canShare={canShare}
        saveAction={saveViewAction}
        deleteAction={deleteViewAction}
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
          rangeHrefs={rangeHrefs(state, retention.hourRetentionDays)}
          scoped={drill.apiId !== null || drill.focus !== null}
          source={source}
          sourceHrefs={sourceHrefs}
          warnings={reader.warnings}
          custom={customForm(custom, state, trafficWindow(range, now), now)}
          exportHref={exportHref(state, 'series')}
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
    rangePhrase: rangePhrase(range),
    rangeWithin: rangeWithin(range),
    exportHref: exportHref(state, 'breakdown'),
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

/**
 * The custom-range form: the window in view (or the refused input, to fix),
 * and the rest of the selection as hidden fields.
 */
function customForm(
  custom: ResolvedView['custom'],
  state: DrillState,
  window: { from: number; to: number },
  now: number,
): CustomRangeForm {
  const shown =
    custom.window !== null
      ? { from: formatUtcMinute(custom.window.from), to: formatUtcMinute(custom.window.to) }
      : (custom.input ?? {
          from: formatUtcMinute(window.from),
          to: formatUtcMinute(Math.min(window.to, now)),
        });
  return { ...shown, hidden: selectionParams(state), problem: custom.problem };
}
