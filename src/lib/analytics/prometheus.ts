import 'server-only';
import type { PrometheusSource } from '@/lib/g2/environments';
import {
  bucketsFromMatrices,
  promSelector,
  trafficQueries,
  type PromGrouping,
  type PromSelection,
  type PromSeries,
} from './promql';
import type { TrafficBucket } from './traffic';

/**
 * The Prometheus datasource's HTTP side (ADR-0015 §5): `query_range` calls
 * made from the server only, with a timeout, and Prometheus's own error
 * surfaced. The URL and credentials come from a `PrometheusSource` and never
 * leave this module: every message is scrubbed of them first.
 */

/** How long one query may take, end to end and on the Prometheus side. */
export const PROMETHEUS_TIMEOUT_MS = 10_000;

/** A Prometheus query failed; `message` is safe to show (scrubbed of URL and credentials). */
export class PrometheusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrometheusError';
  }
}

export type PrometheusDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type RangeWindow = {
  /** Unix seconds of the first evaluation. */
  start: number;
  /** Unix seconds of the last evaluation. */
  end: number;
  stepSeconds: number;
};

export type RangeResult = { series: PromSeries[]; warnings: string[] };

type Envelope = {
  status?: unknown;
  errorType?: unknown;
  error?: unknown;
  warnings?: unknown;
  data?: { resultType?: unknown; result?: unknown };
};

function isSeries(value: unknown): value is PromSeries {
  if (typeof value !== 'object' || value === null) return false;
  const { metric, values } = value as Record<string, unknown>;
  return (
    typeof metric === 'object' &&
    metric !== null &&
    Object.values(metric).every((label) => typeof label === 'string') &&
    Array.isArray(values) &&
    values.every(
      (sample) =>
        Array.isArray(sample) &&
        sample.length === 2 &&
        typeof sample[0] === 'number' &&
        typeof sample[1] === 'string',
    )
  );
}

/** Why the request itself failed, by kind only: fetch errors can name the host. */
function transportMessage(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `Prometheus did not answer within ${timeoutMs / 1000} s`;
  }
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  return `Prometheus is unreachable${code}`;
}

/**
 * Runs one PromQL range query: `POST {base}/api/v1/query_range`. Resolves to
 * the matrix and any warnings; rejects with a `PrometheusError` carrying
 * Prometheus's own `errorType` and `error` when it reports one.
 */
export async function queryRange(
  source: PrometheusSource,
  query: string,
  window: RangeWindow,
  deps: PrometheusDeps = {},
): Promise<RangeResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PROMETHEUS_TIMEOUT_MS;
  const fail = (message: string): never => {
    throw new PrometheusError(source.scrub(message));
  };
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (source.authorization !== null) headers.authorization = source.authorization;
  const body = new URLSearchParams({
    query,
    start: String(window.start),
    end: String(window.end),
    step: `${window.stepSeconds}s`,
    timeout: `${timeoutMs / 1000}s`,
  });

  let response: Response;
  try {
    response = await fetchImpl(`${source.baseUrl}/api/v1/query_range`, {
      method: 'POST',
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return fail(transportMessage(error, timeoutMs));
  }

  let envelope: Envelope | null = null;
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed === 'object' && parsed !== null) envelope = parsed as Envelope;
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return fail(transportMessage(error, timeoutMs));
    }
    envelope = null;
  }
  if (envelope?.status === 'error' && typeof envelope.error === 'string') {
    const kind = typeof envelope.errorType === 'string' ? ` ${envelope.errorType}` : '';
    return fail(`Prometheus${kind}: ${envelope.error}`);
  }
  if (!response.ok || envelope === null) {
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    return fail(
      response.ok
        ? `Prometheus answered ${status} without a JSON body`
        : `Prometheus answered ${status}`,
    );
  }
  const data = envelope.data;
  if (envelope.status !== 'success' || data?.resultType !== 'matrix') {
    return fail('Prometheus answered without a range-query matrix');
  }
  const result = Array.isArray(data.result) ? data.result : [];
  if (!result.every(isSeries)) return fail('Prometheus answered with a malformed matrix');
  const warnings = Array.isArray(envelope.warnings)
    ? envelope.warnings.filter((w): w is string => typeof w === 'string').map(source.scrub, source)
    : [];
  return { series: result, warnings };
}

export type PrometheusTrafficQuery = Omit<PromSelection, 'extra'> & {
  /** The chart window, as `trafficWindow` gives it (Unix ms). */
  from: number;
  to: number;
  stepSeconds: number;
  grouping: PromGrouping;
};

export type PrometheusTraffic = {
  /** Source buckets per group; `''` holds the lot when ungrouped. */
  groups: Map<string, TrafficBucket[]>;
  warnings: string[];
};

/**
 * One view's traffic from Prometheus: the three range queries of ADR-0015 §3,
 * in parallel, evaluated at the end of each step of `[from, to)`.
 */
export async function loadPrometheusTraffic(
  source: PrometheusSource,
  query: PrometheusTrafficQuery,
  deps: PrometheusDeps = {},
): Promise<PrometheusTraffic> {
  const selector = promSelector({
    orgId: query.orgId,
    apiId: query.apiId,
    status: query.status,
    extra: source.selector,
  });
  const queries = trafficQueries(selector, query.stepSeconds, query.grouping);
  const window: RangeWindow = {
    start: query.from / 1000 + query.stepSeconds,
    end: query.to / 1000,
    stepSeconds: query.stepSeconds,
  };
  const [count, bucket, sum] = await Promise.all([
    queryRange(source, queries.count, window, deps),
    queryRange(source, queries.bucket, window, deps),
    queryRange(source, queries.sum, window, deps),
  ]);
  return {
    groups: bucketsFromMatrices(
      { count: count.series, bucket: bucket.series, sum: sum.series },
      query.stepSeconds,
      query.grouping,
    ),
    warnings: [...new Set([...count.warnings, ...bucket.warnings, ...sum.warnings])],
  };
}
