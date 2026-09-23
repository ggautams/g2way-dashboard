import 'server-only';

import { getDatabase } from '@/lib/db';
import { loadApis } from '@/lib/g2/apis';
import { getOrgId, getRegistry, type Registry } from '@/lib/g2/environments';
import { parseIngestConfig, type IngestConfig } from './config';
import { runIngest, type IngestLogger, type IngestSource } from './ingest';
import { templateRuleCache, type DefinitionsLoad } from './path-template';
import { redisQueue } from './queue';
import { analyticsRecordsKey } from './record';

/**
 * Starts the analytics ingest worker for this process (ADR-0012 §2): one loop
 * over every environment that names a Redis URL, draining the configured org's
 * record list. Used by the server at startup (`src/instrumentation.ts`) and by
 * `npm run ingest`.
 */

export type IngestWorker = {
  /** The environments drained. */
  environments: readonly string[];
  /** Stops after the batch in hand, and closes the Redis connections. */
  stop(): Promise<void>;
};

/**
 * How long the worker waits for `GET /g2/apis` when refreshing path templates.
 * Short, because the batch in hand waits on it (ADR-0012 §5); on a timeout the
 * batch is templated with the last rules fetched, or by heuristic.
 */
export const DEFINITIONS_TIMEOUT_MS = 3000;

/** The environment's definitions through the server-side gateway client, settled. */
function definitionsLoader(
  environment: string,
  registry: Registry,
): () => Promise<DefinitionsLoad> {
  return async () => {
    const { apis } = await loadApis(environment, { registry, timeoutMs: DEFINITIONS_TIMEOUT_MS });
    return apis.ok ? apis : { ok: false, error: apis.error };
  };
}

/** The sources to drain: every environment with a Redis URL. */
export function ingestSources(
  registry: Registry,
  orgId: string,
  log: IngestLogger = console,
): IngestSource[] {
  const key = analyticsRecordsKey(orgId);
  return registry.environments.flatMap((target) =>
    target.redisUrl === null
      ? []
      : [
          {
            environment: target.id,
            queue: redisQueue(target.redisUrl, key),
            redisUrl: target.redisUrl,
            templates: templateRuleCache(target.id, definitionsLoader(target.id, registry), {
              log,
            }),
          },
        ],
  );
}

/**
 * Starts the loop, or explains in one log line why not: no environment names a
 * Redis URL, or the configuration is unusable. Never throws, so a misconfigured
 * worker cannot take the dashboard down with it.
 */
export function startIngestWorker(
  options: { config?: IngestConfig; log?: IngestLogger } = {},
): IngestWorker | null {
  const log = options.log ?? console;
  let config: IngestConfig;
  let sources: IngestSource[];
  const orgId = getOrgId();
  try {
    config = options.config ?? parseIngestConfig(process.env);
    sources = ingestSources(getRegistry(), orgId, log);
  } catch (error) {
    log.warn(`[analytics-ingest] not started: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  if (sources.length === 0) {
    log.info('[analytics-ingest] not started: no environment names a Redis URL (G2_REDIS_URL)');
    return null;
  }
  const controller = new AbortController();
  const environments = sources.map((source) => source.environment);
  log.info(
    `[analytics-ingest] draining ${analyticsRecordsKey(orgId)} for ${environments.join(', ')}`,
  );
  const running = runIngest(sources, {
    handle: getDatabase(),
    orgId,
    config,
    signal: controller.signal,
    log,
  }).finally(() => Promise.all(sources.map((source) => source.queue.close())));
  return {
    environments,
    stop: async () => {
      controller.abort();
      await running;
    },
  };
}

// Kept on globalThis so a dev-server module reload does not start a second loop.
const holder = globalThis as typeof globalThis & { __g2IngestWorker?: IngestWorker | null };

/**
 * The server's worker: started once per process unless `G2_ANALYTICS_INGEST`
 * is off (then `npm run ingest` is expected to run it elsewhere).
 */
export function startServerIngestWorker(): IngestWorker | null {
  if (holder.__g2IngestWorker !== undefined) return holder.__g2IngestWorker;
  let config: IngestConfig;
  try {
    config = parseIngestConfig(process.env);
  } catch (error) {
    console.warn(
      `[analytics-ingest] not started: ${error instanceof Error ? error.message : error}`,
    );
    holder.__g2IngestWorker = null;
    return null;
  }
  if (!config.inServer) {
    console.info('[analytics-ingest] off in the server (G2_ANALYTICS_INGEST=off)');
    holder.__g2IngestWorker = null;
    return null;
  }
  holder.__g2IngestWorker = startIngestWorker({ config });
  return holder.__g2IngestWorker;
}
