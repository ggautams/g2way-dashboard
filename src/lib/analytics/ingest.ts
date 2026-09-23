import 'server-only';

import { pruneRollups, recordIngestError, writeIngestBatch } from '@/lib/db/analytics';
import type { DataHandle } from '@/lib/db/users';
import type { IngestConfig } from './config';
import { redisErrorMessage, type RecordQueue } from './queue';
import { parseAnalyticsRecord, type AnalyticsRecord } from './record';
import { rollupBatch } from './rollup';

/**
 * The analytics ingest loop (ADR-0012): drain each environment's record list,
 * fold the batch into rollups, write it in one transaction, prune on the hour.
 *
 * At-most-once (§3): a popped batch lives only here until its transaction
 * commits. A database failure retries the same batch and pops nothing more; a
 * stop request finishes the batch in hand (one last attempt if the database
 * is still failing). Every dependency is injected, so the loop is tested with
 * an in-memory queue and database and no timers.
 */

export type IngestSource = {
  /** The environment id the rollups are filed under. */
  environment: string;
  queue: RecordQueue;
  /** For scrubbing Redis error messages; never logged or stored. */
  redisUrl: string;
};

export type IngestLogger = Pick<Console, 'info' | 'warn'>;

export type IngestDeps = {
  handle: DataHandle;
  orgId: string;
  config: Pick<IngestConfig, 'batchSize' | 'minuteRetentionDays' | 'hourRetentionDays'>;
  signal: AbortSignal;
  now?: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: IngestLogger;
};

/** Pause between passes when no list had a full batch waiting. */
export const IDLE_MS = 2000;
/** Retry backoff for a failing source or database: doubles from the first to the last. */
export const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000] as const;
export const PRUNE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PREFIX = '[analytics-ingest]';

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

function databaseErrorMessage(error: unknown): string {
  return `database: ${error instanceof Error ? error.message : String(error)}`;
}

/** Outcome of one drain of one source. */
export type DrainResult =
  | { kind: 'empty' }
  | { kind: 'written'; popped: number }
  | { kind: 'redis-error'; message: string }
  /** The batch could not be written before the stop; its records are lost. */
  | { kind: 'lost'; popped: number };

/**
 * One drain of one source: pop, parse, fold, write. Retries the write until it
 * lands or the signal aborts (then once more). Errors are recorded on the
 * source's ingest state, best effort.
 */
export async function drainOnce(source: IngestSource, deps: IngestDeps): Promise<DrainResult> {
  const { handle, orgId, config, signal } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const log = deps.log ?? console;
  const { environment } = source;
  const noteError = async (message: string) => {
    try {
      await recordIngestError(handle, orgId, environment, message, new Date(now()));
    } catch {
      // The database is what failed; the log line below is all there is.
    }
  };

  let raw: string[];
  try {
    raw = await source.queue.drain(config.batchSize);
  } catch (error) {
    const message = redisErrorMessage(error, source.redisUrl);
    log.warn(`${PREFIX} ${environment}: ${message}`);
    await noteError(message);
    return { kind: 'redis-error', message };
  }
  if (raw.length === 0) return { kind: 'empty' };
  // The pop succeeded, so the batch is written whatever LLEN says.
  let backlog = 0;
  try {
    backlog = await source.queue.length();
  } catch (error) {
    log.warn(
      `${PREFIX} ${environment}: backlog unknown: ${redisErrorMessage(error, source.redisUrl)}`,
    );
  }

  const records: AnalyticsRecord[] = [];
  let rejected = 0;
  let lastRejection: string | null = null;
  for (const element of raw) {
    const parsed = parseAnalyticsRecord(element, orgId);
    if (parsed.ok) records.push(parsed.record);
    else {
      rejected += 1;
      lastRejection = parsed.reason;
    }
  }
  if (rejected > 0) {
    log.warn(`${PREFIX} ${environment}: dropped ${rejected} malformed record(s): ${lastRejection}`);
  }
  const newest = records.reduce((max, r) => Math.max(max, r.timestamp_unix_ms), -1);
  const batch = {
    environment,
    deltas: rollupBatch(records),
    ingested: records.length,
    rejected,
    lastRejection,
    lastRecordAt: newest < 0 ? null : new Date(newest),
    backlog,
    drainedAt: new Date(now()),
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeIngestBatch(handle, orgId, batch);
      return { kind: 'written', popped: raw.length };
    } catch (error) {
      const message = databaseErrorMessage(error);
      if (signal.aborted && attempt > 0) {
        log.warn(
          `${PREFIX} ${environment}: stopping; ${raw.length} drained record(s) lost: ${message}`,
        );
        return { kind: 'lost', popped: raw.length };
      }
      log.warn(`${PREFIX} ${environment}: write failed, retrying the batch: ${message}`);
      await noteError(message);
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], signal);
    }
  }
}

/**
 * Deletes rollups past retention (ADR-0012 §7). Failures are logged: the next
 * pass tries again.
 */
export async function pruneOnce(deps: IngestDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const { minuteRetentionDays, hourRetentionDays } = deps.config;
  try {
    await pruneRollups(deps.handle, deps.orgId, {
      minuteBefore: new Date(now - minuteRetentionDays * DAY_MS),
      hourBefore: new Date(now - hourRetentionDays * DAY_MS),
    });
  } catch (error) {
    (deps.log ?? console).warn(`${PREFIX} prune failed: ${databaseErrorMessage(error)}`);
  }
}

/**
 * Runs until `deps.signal` aborts. Each pass drains every source once; a
 * source that just had a full batch is drained again without pausing, one
 * whose Redis failed is skipped until its backoff has passed. Prunes at start
 * and then hourly. Never throws.
 */
export async function runIngest(sources: readonly IngestSource[], deps: IngestDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const failures = new Map<string, { count: number; retryAt: number }>();
  let prunedAt = -Infinity;

  while (!deps.signal.aborted) {
    if (now() - prunedAt >= PRUNE_EVERY_MS) {
      prunedAt = now();
      await pruneOnce(deps);
    }
    let busy = false;
    for (const source of sources) {
      if (deps.signal.aborted) break;
      const failure = failures.get(source.environment);
      if (failure !== undefined && now() < failure.retryAt) continue;
      const result = await drainOnce(source, deps);
      if (result.kind === 'redis-error') {
        const count = (failure?.count ?? 0) + 1;
        const wait = BACKOFF_MS[Math.min(count - 1, BACKOFF_MS.length - 1)];
        failures.set(source.environment, { count, retryAt: now() + wait });
        continue;
      }
      failures.delete(source.environment);
      if (result.kind === 'written' && result.popped >= deps.config.batchSize) busy = true;
    }
    if (!busy) await sleep(IDLE_MS, deps.signal);
  }
}
