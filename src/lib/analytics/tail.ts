import type { Drill, DrillFocus, StatusClass } from './drill';
import type { AnalyticsRecord } from './record';
import { truncatePath } from './rollup';

/**
 * The live request inspector's tail (ADR-0014). Pure and universal: which of a
 * drained batch's records are kept, what of each record is kept, how a
 * drill-down selection narrows the tail, and the inspector's URLs.
 *
 * The tail is fed by the ingest worker from the batch in hand, never by a
 * second reader of the gateway's list, which would steal records from the
 * rollups (ADR-0012 §6).
 */

/** How long a tail row is kept, and the most the inspector shows back (by the gateway's timestamp). */
export const TAIL_MAX_AGE_MS = 15 * 60_000;

/** Rows one inspector answer carries at most. */
export const LIVE_LIMIT = 100;

/** How often the inspector polls while live: the worker's idle pause (`IDLE_MS`). */
export const LIVE_POLL_MS = 2000;

/**
 * One kept request: a projection of `AnalyticsRecord`. Client IP and
 * User-Agent are left out on purpose and never stored (ADR-0012 §6,
 * ADR-0014 §3).
 */
export type TailEntry = {
  at: Date;
  apiId: string;
  method: string;
  /** The raw path as the client sent it (g2way records no query string), truncated. */
  path: string;
  /** The value the rollups filed this request's path under (ADR-0012 §5). */
  pathTemplate: string;
  status: number;
  latencyMs: number;
  upstreamLatencyMs: number | null;
  keyHash: string | null;
  keyAlias: string | null;
  requestBytes: number | null;
  responseBytes: number | null;
};

/**
 * The records of one batch the tail keeps: at most `limit`, the newest by the
 * gateway's timestamp (ties keep pop order), and none older than
 * `TAIL_MAX_AGE_MS`, so a worker catching up on a backlog does not fill the
 * tail with requests the inspector would never show. `pathOf` is the worker's
 * templater, the same one the rollups use.
 */
export function tailEntries(
  records: readonly AnalyticsRecord[],
  pathOf: (record: AnalyticsRecord) => string,
  limit: number,
  now: number,
): TailEntry[] {
  if (limit <= 0) return [];
  const oldest = now - TAIL_MAX_AGE_MS;
  return records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.timestamp_unix_ms >= oldest)
    .sort((a, b) => b.record.timestamp_unix_ms - a.record.timestamp_unix_ms || b.index - a.index)
    .slice(0, limit)
    .map(({ record }) => ({
      at: new Date(record.timestamp_unix_ms),
      apiId: record.api_id,
      method: record.method,
      path: truncatePath(record.path),
      pathTemplate: truncatePath(pathOf(record)),
      status: record.status,
      latencyMs: record.latency_ms,
      upstreamLatencyMs: record.upstream_latency_ms ?? null,
      keyHash: record.key_hash ?? null,
      keyAlias: record.key_alias ?? null,
      requestBytes: record.request_content_length ?? null,
      responseBytes: record.response_content_length ?? null,
    }));
}

/**
 * Which tail rows a selection reads. `keyHash: null` is the keyless requests;
 * an absent field does not narrow.
 */
export type TailFilter = {
  apiId?: string;
  keyHash?: string | null;
  status?: number;
  statusClass?: StatusClass;
  method?: string;
  pathTemplate?: string;
};

/**
 * A drill-down selection (`parseDrill`) as a tail filter. The same URL
 * parameters mean the same thing on `/analytics` and `/analytics/live`: a path
 * value is a template, matched against `path_template`.
 */
export function tailFilter(drill: Pick<Drill, 'apiId' | 'focus'>): TailFilter {
  const filter: TailFilter = {};
  if (drill.apiId !== null) filter.apiId = drill.apiId;
  const { focus } = drill;
  if (focus === null) return filter;
  switch (focus.dimension) {
    case 'key':
      filter.keyHash = focus.value === '' ? null : focus.value;
      break;
    case 'status':
      if (/^[1-5]xx$/.test(focus.value)) filter.statusClass = Number(focus.value[0]) as StatusClass;
      else filter.status = Number(focus.value);
      break;
    case 'method':
      filter.method = focus.value;
      break;
    case 'path':
      filter.pathTemplate = focus.value;
      break;
  }
  return filter;
}

/** The inspector's URL for a selection; parameters in `drillHref`'s order. */
export function liveHref(selection: { apiId: string | null; focus: DrillFocus | null }): string {
  const params = new URLSearchParams();
  if (selection.apiId !== null) params.set('api', selection.apiId);
  if (selection.focus !== null) params.set(selection.focus.dimension, selection.focus.value);
  const query = params.toString();
  return query === '' ? '/analytics/live' : `/analytics/live?${query}`;
}

/** The inspector's poll URL for a selection (`src/app/api/analytics/live/route.ts`). */
export function livePollUrl(selection: { apiId: string | null; focus: DrillFocus | null }): string {
  return liveHref(selection).replace('/analytics/live', '/api/analytics/live');
}

/** A key as the inspector shows it: never the full hash (ADR-0010 treats it as an id, not a secret). */
export type LiveKey = {
  /** The hash, for links and filters; `null` for keyless requests. */
  hash: string | null;
  label: string;
  detail: string | null;
  mono: boolean;
};

/** One request as the browser receives it. `key` is present only for roles with `keys:read`. */
export type LiveRequest = {
  id: string;
  at: number;
  apiId: string;
  method: string;
  path: string;
  pathTemplate: string;
  status: number;
  latencyMs: number;
  upstreamLatencyMs: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
  key?: LiveKey;
};

/** One inspector answer: the newest matching requests, newest first. */
export type LiveSnapshot = {
  requests: LiveRequest[];
  /** Server time of the read, for "ago" labels. */
  now: number;
};
