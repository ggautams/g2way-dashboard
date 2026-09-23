import type { AnalyticsIngestState } from '@/lib/db/analytics';

/**
 * Ingest health for the traffic pages (ADR-0012 §8): why an environment's
 * charts are empty or incomplete, read from `analytics_ingest_state`. Pure, so
 * each case is tested directly; the page gathers the inputs.
 *
 * The cases the page must tell apart:
 * - `not-configured`: the environment names no Redis URL, so nothing drains;
 * - `no-worker`: no worker has reported for this environment within
 *   `WORKER_STALE_MS`, or ever. Its heartbeat is the newest of
 *   `last_polled_at`, `last_drained_at` and `last_error_at`: a live worker
 *   moves one of them at least every `HEARTBEAT_MS` when idle, and every
 *   backoff step (at most 60 s) when failing;
 * - `failing`: the worker's last error is newer than its last successful pop
 *   (`last_polled_at`, or `last_drained_at` for rows an older worker wrote);
 * - `not-sending`: a worker polls, but has never popped a record: the gateway
 *   is not running the `redis` sink against this Redis, or served no traffic;
 * - `ok`: records are arriving.
 *
 * A backlog near g2way's cap is reported beside any of the last four: it means
 * the gateway is already trimming the oldest records.
 */

/** g2way's `RedisListSink::DEFAULT_MAX_RECORDS`: the list is trimmed to this length. */
export const GATEWAY_RECORD_CAP = 100_000;
/** Above this share of the cap, the gateway is about to (or already does) drop records. */
export const BACKLOG_WARN_RATIO = 0.8;
/**
 * A worker silent this long is taken for stopped: four idle heartbeats
 * (`HEARTBEAT_MS`, 30 s), or two of the longest Redis backoff steps (60 s),
 * with room for clock skew between the page's server and a standalone worker.
 */
export const WORKER_STALE_MS = 120_000;

export type IngestStateFields = Pick<
  AnalyticsIngestState,
  | 'recordsIngested'
  | 'recordsRejected'
  | 'batches'
  | 'backlog'
  | 'lastDrainedAt'
  | 'lastPolledAt'
  | 'lastRecordAt'
  | 'lastRejection'
  | 'lastError'
  | 'lastErrorAt'
>;

export type IngestHealthInput = {
  /** Whether the environment names a Redis URL (never the URL itself). */
  redisConfigured: boolean;
  /** Whether this server process runs the worker (`G2_ANALYTICS_INGEST`, and a valid config). */
  workerInServer: boolean;
  /** The environment's row, or `undefined` when no worker ever reported. */
  state: IngestStateFields | undefined;
  /** The time of the read (Unix ms), against which the heartbeat is judged. */
  now: number;
};

export type IngestStatus = 'not-configured' | 'no-worker' | 'failing' | 'not-sending' | 'ok';

export type IngestHealth = {
  status: IngestStatus;
  /** The last reported backlog, and whether it is near the cap; `null` without a report. */
  backlog: { count: number; nearCap: boolean; asOf: Date | null } | null;
  /** When a worker last reported for this environment; `null` if none ever did. */
  lastSeenAt: Date | null;
  workerInServer: boolean;
  state: IngestStateFields | undefined;
};

export function ingestHealth({
  redisConfigured,
  workerInServer,
  state,
  now,
}: IngestHealthInput): IngestHealth {
  if (!redisConfigured) {
    return {
      status: 'not-configured',
      backlog: null,
      lastSeenAt: null,
      workerInServer,
      state: undefined,
    };
  }
  const backlog =
    state === undefined
      ? null
      : {
          count: state.backlog,
          nearCap: state.backlog >= GATEWAY_RECORD_CAP * BACKLOG_WARN_RATIO,
          // Every write of `backlog` also writes `last_polled_at`, except an
          // older worker's, which wrote only `last_drained_at`.
          asOf: state.lastPolledAt ?? state.lastDrainedAt,
        };
  const lastSeenAt = newest(state?.lastPolledAt, state?.lastDrainedAt, state?.lastErrorAt);
  return { status: statusOf(state, lastSeenAt, now), backlog, lastSeenAt, workerInServer, state };
}

function newest(...dates: (Date | null | undefined)[]): Date | null {
  let result: Date | null = null;
  for (const date of dates) {
    if (date != null && (result === null || date > result)) result = date;
  }
  return result;
}

function statusOf(
  state: IngestStateFields | undefined,
  lastSeenAt: Date | null,
  now: number,
): IngestStatus {
  if (state === undefined || lastSeenAt === null) return 'no-worker';
  if (now - lastSeenAt.getTime() > WORKER_STALE_MS) return 'no-worker';
  const { lastErrorAt, lastDrainedAt } = state;
  const lastSuccess = newest(state.lastPolledAt, lastDrainedAt);
  if (lastErrorAt !== null && (lastSuccess === null || lastErrorAt > lastSuccess)) {
    return 'failing';
  }
  return lastDrainedAt === null ? 'not-sending' : 'ok';
}
