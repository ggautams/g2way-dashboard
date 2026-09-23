import type { AnalyticsIngestState } from '@/lib/db/analytics';

/**
 * Ingest health for the traffic pages (ADR-0012 §8): why an environment's
 * charts are empty or incomplete, read from `analytics_ingest_state`. Pure, so
 * each case is tested directly; the page gathers the inputs.
 *
 * The cases the page must tell apart:
 * - `not-configured`: the environment names no Redis URL, so nothing drains;
 * - `failing`: the worker's last error is newer than its last drain (or it has
 *   never drained and has failed);
 * - `not-sending`: no drain has ever popped a record. Either the gateway is not
 *   running the `redis` sink, or no worker runs at all; the state table cannot
 *   tell those apart, so the page names both;
 * - `ok`: records are arriving.
 *
 * A backlog near g2way's cap is reported beside any of the last three: it means
 * the gateway is already trimming the oldest records.
 */

/** g2way's `RedisListSink::DEFAULT_MAX_RECORDS`: the list is trimmed to this length. */
export const GATEWAY_RECORD_CAP = 100_000;
/** Above this share of the cap, the gateway is about to (or already does) drop records. */
export const BACKLOG_WARN_RATIO = 0.8;

export type IngestStateFields = Pick<
  AnalyticsIngestState,
  | 'recordsIngested'
  | 'recordsRejected'
  | 'batches'
  | 'backlog'
  | 'lastDrainedAt'
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
};

export type IngestStatus = 'not-configured' | 'failing' | 'not-sending' | 'ok';

export type IngestHealth = {
  status: IngestStatus;
  /** The last reported backlog, and whether it is near the cap; `null` without a report. */
  backlog: { count: number; nearCap: boolean; asOf: Date | null } | null;
  workerInServer: boolean;
  state: IngestStateFields | undefined;
};

export function ingestHealth({
  redisConfigured,
  workerInServer,
  state,
}: IngestHealthInput): IngestHealth {
  if (!redisConfigured) {
    return { status: 'not-configured', backlog: null, workerInServer, state: undefined };
  }
  const backlog =
    state === undefined
      ? null
      : {
          count: state.backlog,
          nearCap: state.backlog >= GATEWAY_RECORD_CAP * BACKLOG_WARN_RATIO,
          asOf: state.lastDrainedAt,
        };
  return { status: statusOf(state), backlog, workerInServer, state };
}

function statusOf(state: IngestStateFields | undefined): IngestStatus {
  if (state === undefined) return 'not-sending';
  const { lastErrorAt, lastDrainedAt } = state;
  if (lastErrorAt !== null && (lastDrainedAt === null || lastErrorAt > lastDrainedAt)) {
    return 'failing';
  }
  return lastDrainedAt === null ? 'not-sending' : 'ok';
}
