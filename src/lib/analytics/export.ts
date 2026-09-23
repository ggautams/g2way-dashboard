import 'server-only';

import { can } from '@/lib/auth/rbac';
import { getDatabase } from '@/lib/db';
import { listKeyMetadata } from '@/lib/db/key-metadata';
import type { User } from '@/lib/db/users';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  getOrgId,
  resolveEnvironment,
  type GatewayTarget,
} from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';
import { shortHash } from '@/lib/keys/session';
import {
  BREAKDOWN_HEADER,
  SERIES_HEADER,
  breakdownRows,
  exportFileName,
  seriesRows,
  toCsv,
} from './csv';
import {
  PATH_TEMPLATE_NOTE,
  breakdownPlan,
  describeValue,
  subtractBucket,
  totalOf,
  type BreakdownDimension,
} from './drill';
import { PrometheusError } from './prometheus';
import { elapsedSeconds, rangePhrase, trafficWindow, type TrafficBucket } from './traffic';
import { resolveView, type ResolvedView } from './view';

/**
 * `GET /api/analytics/export?table=series|breakdown&…` (ADR-0013 §8): the
 * `/analytics` view named by the rest of the URL, as CSV. It reads through
 * the page's own `resolveView`, so a download is the view on screen, and
 * never touches the live inspector's tail, which is a sample (ADR-0014).
 */

/** The most breakdown groups one export lists before "Everything else". */
export const EXPORT_BREAKDOWN_ROWS = 1000;

export type ExportTable = 'series' | 'breakdown';

const NO_STORE = { 'cache-control': 'no-store' };

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/** What the numbers are, per source: said in every file, since a CSV travels without the page. */
export function sourceNote(source: ResolvedView['source']): string {
  return source === 'prometheus'
    ? 'From Prometheus: counts are increase() of g2way’s request-duration histogram per step, rounded to whole requests and summed over replicas. Percentiles are estimated from its buckets (5 ms to 10 s). The metric keeps no maximum, so latency_max_ms is empty.'
    : 'From the dashboard’s rollups of the gateway’s analytics records: counts and latency_max_ms are exact; percentiles are estimated from a latency histogram (buckets up to 10 s).';
}

/** The `#` rows that open every export: what view this is. */
export function exportMeta(
  target: Pick<GatewayTarget, 'id' | 'label'>,
  view: Pick<ResolvedView, 'source' | 'range' | 'drill' | 'notes'>,
  table: ExportTable,
  now: number,
): [string, string][] {
  const window = trafficWindow(view.range, now);
  const meta: [string, string][] = [
    ['g2way-dashboard traffic export', table],
    ['environment', `${target.label} (${target.id})`],
    ['source', view.source],
    ['range', rangePhrase(view.range)],
    ['from_utc', new Date(window.from).toISOString()],
    ['to_utc', new Date(window.to).toISOString()],
    ['step_seconds', String(view.range.stepSeconds)],
  ];
  if (view.drill.apiId !== null) meta.push(['api', view.drill.apiId]);
  if (view.drill.focus !== null) meta.push([view.drill.focus.dimension, view.drill.focus.value]);
  if (table === 'breakdown' && view.drill.by !== null) meta.push(['breakdown', view.drill.by]);
  meta.push(['exported_at_utc', new Date(now).toISOString()]);
  meta.push(['note', sourceNote(view.source)]);
  if (window.to > now) {
    meta.push([
      'note',
      'The last step is still filling: its req_per_s divides by the time elapsed in it.',
    ]);
  }
  if (table === 'breakdown' && view.drill.by === 'path') meta.push(['note', PATH_TEMPLATE_NOTE]);
  for (const note of view.notes) meta.push(['note', note]);
  return meta;
}

/** Answers the export, or refuses it in the gateway's `{"error"}` envelope. */
export async function trafficExportResponse(request: Request, user: User): Promise<Response> {
  if (!can(user.role, 'gateway:read')) {
    return refuse(
      403,
      `forbidden: the ${user.role} role lacks the gateway:read permission (traffic export)`,
    );
  }
  let target: GatewayTarget;
  try {
    target = resolveEnvironment(await selectedEnvironmentId());
  } catch (error) {
    if (error instanceof RegistryConfigError || error instanceof UnknownEnvironmentError) {
      return refuse(409, error.message);
    }
    throw error;
  }
  const url = new URL(request.url);
  const table = url.searchParams.get('table');
  if (table !== 'series' && table !== 'breakdown') {
    return refuse(400, 'table must be series or breakdown');
  }
  const now = Date.now();
  const view = resolveView(target, Object.fromEntries(url.searchParams), {
    keys: can(user.role, 'keys:read'),
    now,
  });
  if (table === 'breakdown' && view.drill.by === null) {
    return refuse(400, 'this selection has no breakdown to export: it cannot be split further');
  }

  let body: string;
  try {
    body =
      table === 'series'
        ? await seriesCsv(target, view, now)
        : await breakdownCsv(target, view, view.drill.by!, now);
  } catch (error) {
    if (error instanceof PrometheusError) return refuse(502, error.message);
    throw error;
  }
  const window = trafficWindow(view.range, now);
  const name = exportFileName(table, target.id, window.from, Math.min(window.to, now));
  return new Response(body, {
    headers: {
      ...NO_STORE,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'x-content-type-options': 'nosniff',
    },
  });
}

async function seriesCsv(target: GatewayTarget, view: ResolvedView, now: number): Promise<string> {
  const buckets = await view.reader.total();
  return toCsv(
    exportMeta(target, view, 'series', now),
    SERIES_HEADER,
    seriesRows(view.range, buckets, now, view.reader.options),
  );
}

async function breakdownCsv(
  target: GatewayTarget,
  view: ResolvedView,
  by: BreakdownDimension,
  now: number,
): Promise<string> {
  const window = trafficWindow(view.range, now);
  const [total, { rows }] = await Promise.all([
    view.reader.total(),
    view.reader.breakdown(by, EXPORT_BREAKDOWN_ROWS),
  ]);
  const plan = breakdownPlan(view.drill, by);
  // `by=key` is only offered with keys:read (`parseDrill`), so labels are read only then.
  const keyLabels =
    by === 'key'
      ? await listKeyMetadata(
          getDatabase(),
          getOrgId(),
          target.id,
          rows.map((row) => row.group),
        )
      : new Map<string, { label: string | null }>();
  const buckets: TrafficBucket[] = rows.map((row) => ({ ...row, start: window.from }));
  const all = totalOf(total, window.from);
  const groups = rows.map((row, i) => {
    const value = plan.group === 'class' ? `${row.group}xx` : row.group;
    const { label } = describeValue(by, value, {
      keyLabel: keyLabels.get(row.group)?.label ?? null,
      alias: row.label,
      shortHash,
    });
    return { value, label, bucket: buckets[i] };
  });
  const dimension = by === 'status' ? (plan.group === 'class' ? 'status_class' : 'status') : by;
  return toCsv(
    exportMeta(target, view, 'breakdown', now),
    BREAKDOWN_HEADER,
    breakdownRows(
      dimension,
      groups,
      subtractBucket(all, buckets),
      all.requests,
      elapsedSeconds(window.from, window.to - window.from, now),
      view.reader.options,
    ),
  );
}
