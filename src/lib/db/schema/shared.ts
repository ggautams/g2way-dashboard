/**
 * Dialect-neutral pieces of the dashboard schema. `sqlite.ts` and `pg.ts` each
 * declare the same tables in their own dialect (Drizzle table builders are
 * dialect-typed); anything both need to agree on lives here, and
 * `schema.test.ts` fails if the two drift apart. See ADR-0003.
 */

/** Dashboard roles. Stored as text, so changing this list needs no migration. */
export const ROLES = ['owner', 'admin', 'editor', 'viewer', 'portal-dev'] as const;
export type Role = (typeof ROLES)[number];

/**
 * How an audited action ended (ADR-0006). `pending` marks a gateway write whose
 * row was written before the call and not yet completed.
 */
export const AUDIT_OUTCOMES = ['pending', 'success', 'failure', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * What a failed sign-in is counted against (sign-in throttling): the address
 * tried, and the client it came from.
 */
export const THROTTLE_KINDS = ['email', 'client'] as const;
export type ThrottleKind = (typeof THROTTLE_KINDS)[number];

/** Gateway config kinds whose history the dashboard keeps (ADR-0008). */
export const CONFIG_KINDS = ['api', 'policy'] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

/**
 * How a config version came to be: a write through the dashboard, or the
 * `baseline` state found before the first one (so the first edit of a
 * definition made elsewhere can still be undone).
 */
export const VERSION_ACTIONS = ['baseline', 'create', 'update', 'delete'] as const;
export type VersionAction = (typeof VERSION_ACTIONS)[number];

/** Stand-in type for audit before/after snapshots: any JSON value. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then a 12-bit counter in
 * `rand_a` (method 1), then random bits. Ids from one process are strictly
 * increasing as text, even within one millisecond or if the clock steps back,
 * so `ORDER BY created_at, id` is insertion order for one server's rows
 * (ADR-0006). Still an app-generated text UUID (ADR-0003 §2): no migration.
 */
export function monotonicUuid(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = Math.max(now, monotonic.lastMs);
  if (ms === monotonic.lastMs) {
    monotonic.counter += 1;
    if (monotonic.counter > 0xfff) {
      // Counter exhausted: borrow the next millisecond.
      ms += 1;
      monotonic.counter = 0;
    }
  } else {
    // A fresh millisecond starts the counter low but random, leaving headroom.
    monotonic.counter = ((bytes[6] << 8) | bytes[7]) & 0x7ff;
  }
  monotonic.lastMs = ms;

  let rest = ms;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  bytes[6] = 0x70 | (monotonic.counter >> 8);
  bytes[7] = monotonic.counter & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const monotonic = { lastMs: 0, counter: 0 };

/**
 * What one `analytics_rollups` row breaks traffic down by (ADR-0012 §5): the
 * API's total (`api`, value `''`), or one key hash, method, exact status code
 * or path within that API.
 */
export const ROLLUP_DIMENSIONS = ['api', 'key', 'method', 'status', 'path'] as const;
export type RollupDimension = (typeof ROLLUP_DIMENSIONS)[number];

/** Rollup bucket widths, in seconds: minute and hour (ADR-0012 §5). */
export const ROLLUP_BUCKET_SECONDS = [60, 3600] as const;
export type RollupBucketSeconds = (typeof ROLLUP_BUCKET_SECONDS)[number];

/**
 * Upper bounds (ms, inclusive) of the latency histogram's buckets. Each bound
 * is a column, `latency_le_<bound>`, holding a non-cumulative count; latencies
 * above the last bound count in `latency_over`. Changing this list is a
 * migration.
 */
export const LATENCY_BOUNDS_MS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;
export type LatencyBound = (typeof LATENCY_BOUNDS_MS)[number];

/** The row property holding the count for one histogram bucket. */
export type LatencyBucketKey = `latencyLe${LatencyBound}`;

/** The row property of `bound`'s histogram bucket. */
export function latencyBucketKey(bound: LatencyBound): LatencyBucketKey {
  return `latencyLe${bound}`;
}

/**
 * The histogram columns, built once per dialect from `LATENCY_BOUNDS_MS` so the
 * two schemas cannot list different buckets. `column` makes one non-null
 * counter column from its SQL name.
 */
export function latencyColumns<C>(column: (name: string) => C): Record<LatencyBucketKey, C> {
  return Object.fromEntries(
    LATENCY_BOUNDS_MS.map((bound) => [latencyBucketKey(bound), column(`latency_le_${bound}`)]),
  ) as Record<LatencyBucketKey, C>;
}
