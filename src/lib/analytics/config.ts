/**
 * The ingest worker's settings (ADR-0012), from the process environment. Pure,
 * so it is tested directly. Which environments are drained is not here: that is
 * each environment's Redis URL, in the registry (`src/lib/g2/environments.ts`).
 */

export type IngestConfig = {
  /** Whether the dashboard server runs the worker itself (`G2_ANALYTICS_INGEST`). */
  inServer: boolean;
  /** Records popped per drain (`G2_ANALYTICS_BATCH`): also the most a hard crash can lose. */
  batchSize: number;
  /** Minute rollups older than this many days are pruned. */
  minuteRetentionDays: number;
  /** Hour rollups older than this many days are pruned. */
  hourRetentionDays: number;
};

export const INGEST_DEFAULTS: IngestConfig = {
  inServer: true,
  batchSize: 1000,
  minuteRetentionDays: 3,
  hourRetentionDays: 90,
};

/** The settings are unusable; `problems` names each offending variable. */
export class IngestConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`analytics ingest configuration is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'IngestConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function integer(
  env: Env,
  name: string,
  fallback: number,
  [min, max]: readonly [number, number],
  problems: string[],
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

export function parseIngestConfig(env: Env): IngestConfig {
  const problems: string[] = [];
  const switchValue = env.G2_ANALYTICS_INGEST?.trim().toLowerCase();
  let inServer = INGEST_DEFAULTS.inServer;
  if (switchValue === 'off' || switchValue === 'false' || switchValue === '0') inServer = false;
  else if (switchValue && !['on', 'true', '1'].includes(switchValue)) {
    problems.push('G2_ANALYTICS_INGEST must be on or off');
  }
  const config: IngestConfig = {
    inServer,
    // LPOP's count is a Redis integer; 10 000 keeps one batch's transaction modest.
    batchSize: integer(env, 'G2_ANALYTICS_BATCH', INGEST_DEFAULTS.batchSize, [1, 10_000], problems),
    minuteRetentionDays: integer(
      env,
      'G2_ANALYTICS_MINUTE_RETENTION_DAYS',
      INGEST_DEFAULTS.minuteRetentionDays,
      [1, 90],
      problems,
    ),
    hourRetentionDays: integer(
      env,
      'G2_ANALYTICS_HOUR_RETENTION_DAYS',
      INGEST_DEFAULTS.hourRetentionDays,
      [1, 3650],
      problems,
    ),
  };
  if (problems.length > 0) throw new IngestConfigError(problems);
  return config;
}
