import 'server-only';

import { getDatabase } from '@/lib/db';
import { getIngestState } from '@/lib/db/analytics';
import { getOrgId, type GatewayTarget } from '@/lib/g2/environments';
import { INGEST_DEFAULTS, IngestConfigError, parseIngestConfig } from './config';
import { ingestHealth } from './health';

/**
 * The environment's ingest health (ADR-0012 §8), and the time it was read (for
 * the "ago" labels). Shared by every traffic page, so an empty chart or an
 * empty inspector always says why.
 */
export async function loadIngestHealth(target: GatewayTarget) {
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

/**
 * How long this server's settings keep minute and hour rollups (ADR-0012 §7),
 * for the custom range's choice of rows. Invalid settings fall back to the
 * defaults here: the health panel already reports them.
 */
export function rollupRetention(): { minuteRetentionDays: number; hourRetentionDays: number } {
  try {
    const { minuteRetentionDays, hourRetentionDays } = parseIngestConfig(process.env);
    return { minuteRetentionDays, hourRetentionDays };
  } catch (error) {
    if (!(error instanceof IngestConfigError)) throw error;
    const { minuteRetentionDays, hourRetentionDays } = INGEST_DEFAULTS;
    return { minuteRetentionDays, hourRetentionDays };
  }
}
