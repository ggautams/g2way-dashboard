import 'server-only';

import { getDatabase } from '@/lib/db';
import { getIngestState } from '@/lib/db/analytics';
import { getOrgId, type GatewayTarget } from '@/lib/g2/environments';
import { IngestConfigError, parseIngestConfig } from './config';
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
