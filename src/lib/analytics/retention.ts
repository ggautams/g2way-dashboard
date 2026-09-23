import { trafficWindow, type FixedTrafficRange, type TrafficSource } from './traffic';

/**
 * What rollup retention (ADR-0012 §7) means for a traffic range (ADR-0013 §5,
 * §7). Pure and universal. A range that starts before minute retention reads
 * hour rows instead, one hour per step or more; a range that starts before
 * hour retention is shown as it is, with a note that the older part was
 * pruned. Both notes are shared by the fixed ranges and the custom windows, so
 * the page says the same thing whichever way the range was picked.
 */

/** How long this server's settings keep each rollup granularity, in days. */
export type RollupRetention = { minuteRetentionDays: number; hourRetentionDays: number };

const DAY_MS = 86_400_000;

/**
 * Whether minute rows still cover a range starting at `from`, and the notes
 * to show for it at `now`. A range that reads hour rows anyway (`minuteRows`
 * false) gets only the hour-retention note.
 */
export function retentionNotes(
  from: number,
  now: number,
  retention: RollupRetention,
  minuteRows = true,
): { minuteRowsGone: boolean; notes: string[] } {
  const notes: string[] = [];
  const minuteRowsGone = minuteRows && from < now - retention.minuteRetentionDays * DAY_MS;
  if (minuteRowsGone) {
    notes.push(
      `Minute rollups are kept ${retention.minuteRetentionDays} days (G2_ANALYTICS_MINUTE_RETENTION_DAYS) and this range starts before that, so it reads hour rollups, one hour per step or more.`,
    );
  }
  const hourCutoff = now - retention.hourRetentionDays * DAY_MS;
  if (from < hourCutoff) {
    notes.push(
      `Hour rollups are kept ${retention.hourRetentionDays} days (G2_ANALYTICS_HOUR_RETENTION_DAYS): nothing before ${new Date(hourCutoff).toISOString().slice(0, 16).replace('T', ' ')} UTC remains.`,
    );
  }
  return { minuteRowsGone, notes };
}

/**
 * A fixed range as the rollups can answer it at `now`: minute rows while
 * minute retention covers its window, else hour rows at a step of at least an
 * hour (every fixed range is a whole number of hours). Prometheus keeps its
 * own retention, so its ranges are returned as they are, without notes.
 */
export function retainedRange(
  range: FixedTrafficRange,
  context: { source: TrafficSource; now: number } & RollupRetention,
): { range: FixedTrafficRange; notes: string[] } {
  const { source, now } = context;
  if (source !== 'rollups') return { range, notes: [] };
  const { from } = trafficWindow(range, now);
  const { minuteRowsGone, notes } = retentionNotes(from, now, context, range.sourceSeconds === 60);
  if (!minuteRowsGone) return { range, notes };
  const hourly: FixedTrafficRange = {
    ...range,
    sourceSeconds: 3_600,
    stepSeconds: Math.max(range.stepSeconds, 3_600),
  };
  return { range: hourly, notes };
}
