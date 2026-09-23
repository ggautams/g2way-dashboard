import type { TrafficRange, TrafficSource } from './traffic';

/**
 * Custom date ranges on `/analytics` (ADR-0013 §7): an absolute window typed
 * as `?from=` and `?to=` in UTC, turned into a `TrafficRange` that the rest of
 * the traffic code reads like a fixed one. Pure and universal.
 *
 * The step is the shortest in `CUSTOM_STEPS` that keeps the chart at or under
 * `MAX_CUSTOM_POINTS`. The rollups read minute rows for sub-hour steps, but
 * only while the window starts inside minute retention; past it only hour rows
 * exist, so the step becomes an hour or more. Prometheus gets at least two
 * scrapes per step at its default one-minute scrape interval, and stays far
 * below its 11 000 points per series (ADR-0015).
 */

/** A custom window as asked for: Unix ms, UTC, `from` inclusive, `to` exclusive. */
export type CustomWindow = { from: number; to: number };

/** Chart steps a custom range may use, in seconds. Hour and longer are whole hours. */
export const CUSTOM_STEPS = [
  60, 120, 300, 600, 900, 1_800, 3_600, 10_800, 21_600, 43_200, 86_400,
] as const;

/** The most points one custom chart draws: 400 days at one-day steps. */
export const MAX_CUSTOM_POINTS = 400;

/** The shortest custom range: five one-minute points. */
export const MIN_CUSTOM_SECONDS = 300;

/**
 * The shortest step under Prometheus: two scrapes at Prometheus's default
 * `scrape_interval` of one minute, so `increase()` always has two samples.
 */
export const PROMETHEUS_MIN_STEP_SECONDS = 120;

/** Prometheus refuses a range query past this many points per series. */
export const PROMETHEUS_MAX_POINTS = 11_000;

const DAY_MS = 86_400_000;
const UTC_MINUTE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?Z?$/;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A UTC date and time as `YYYY-MM-DDTHH:mm` (a `datetime-local` input's own
 * value format), seconds optional, or a bare date for its midnight. `null` for
 * anything else, impossible dates included (`2026-02-30`).
 */
export function parseUtcMinute(value: string): number | null {
  const match = UTC_MINUTE.exec(value.trim());
  if (match === null) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = match;
  const parts = [y, mo, d, h, mi, s].map(Number);
  const ms = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  const back = new Date(ms);
  const same =
    back.getUTCFullYear() === parts[0] &&
    back.getUTCMonth() === parts[1] - 1 &&
    back.getUTCDate() === parts[2] &&
    back.getUTCHours() === parts[3] &&
    back.getUTCMinutes() === parts[4] &&
    back.getUTCSeconds() === parts[5];
  return same ? ms : null;
}

/** `YYYY-MM-DDTHH:mm` in UTC: the URL form and a `datetime-local` input's value. */
export function formatUtcMinute(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `YYYY-MM-DD HH:mm`, for labels. */
function labelTime(ms: number): string {
  return formatUtcMinute(ms).replace('T', ' ');
}

/**
 * The custom window `?from=` and `?to=` ask for; `null` when neither is
 * given. Only one of them, or one that does not parse, is a problem to show.
 */
export function readCustomWindow(
  from: string | undefined,
  to: string | undefined,
): { window: CustomWindow } | { problem: string } | null {
  const given = (value: string | undefined) => value !== undefined && value.trim() !== '';
  if (!given(from) && !given(to)) return null;
  if (!given(from) || !given(to)) {
    return { problem: 'A custom range needs both a start (from) and an end (to).' };
  }
  const start = parseUtcMinute(from!);
  const end = parseUtcMinute(to!);
  const bad = (name: string, value: string) =>
    `${name}=${value.slice(0, 40)}: not a UTC date and time (YYYY-MM-DDTHH:mm).`;
  if (start === null) return { problem: bad('from', from!) };
  if (end === null) return { problem: bad('to', to!) };
  return { window: { from: start, to: end } };
}

export type CustomRangeContext = {
  source: TrafficSource;
  now: number;
  /** How long minute and hour rollups are kept (ADR-0012 §7); ignored under Prometheus. */
  minuteRetentionDays: number;
  hourRetentionDays: number;
};

/**
 * The range a custom window reads as at `now`, with notes on what changed
 * (an end in the future becomes now; old minutes become hours), or the reason
 * it cannot be shown: inverted, starting in the future, too short, too long.
 */
export function customRange(
  window: CustomWindow,
  context: CustomRangeContext,
): { range: TrafficRange; notes: string[] } | { problem: string } {
  const { source, now } = context;
  if (window.to <= window.from) {
    return { problem: 'The custom range ends before it starts: pick an end after the start.' };
  }
  if (window.from >= now) {
    return { problem: 'The custom range starts in the future: nothing has been recorded yet.' };
  }
  const notes: string[] = [];
  let end = window.to;
  if (end > now) {
    end = now;
    notes.push(`to=${formatUtcMinute(window.to)} is in the future; the range ends now.`);
  }
  if ((end - window.from) / 1000 < MIN_CUSTOM_SECONDS) {
    return { problem: 'The custom range is shorter than 5 minutes: pick a longer one.' };
  }

  let minStep: number = source === 'prometheus' ? PROMETHEUS_MIN_STEP_SECONDS : 60;
  if (source === 'rollups') {
    const minuteCutoff = now - context.minuteRetentionDays * DAY_MS;
    const hourCutoff = now - context.hourRetentionDays * DAY_MS;
    if (window.from < minuteCutoff) {
      minStep = 3_600;
      notes.push(
        `Minute rollups are kept ${context.minuteRetentionDays} days (G2_ANALYTICS_MINUTE_RETENTION_DAYS) and this range starts before that, so it reads hour rollups, one hour per step or more.`,
      );
    }
    if (window.from < hourCutoff) {
      notes.push(
        `Hour rollups are kept ${context.hourRetentionDays} days (G2_ANALYTICS_HOUR_RETENTION_DAYS): nothing before ${labelTime(hourCutoff)} UTC remains.`,
      );
    }
  }

  const fit = CUSTOM_STEPS.filter((step) => step >= minStep)
    .map((step) => {
      const stepMs = step * 1000;
      const from = Math.floor(window.from / stepMs) * stepMs;
      const to = Math.ceil(end / stepMs) * stepMs;
      return { step, from, to, points: (to - from) / stepMs };
    })
    .find((candidate) => candidate.points <= MAX_CUSTOM_POINTS);
  if (fit === undefined) {
    return {
      problem: `The custom range is longer than ${MAX_CUSTOM_POINTS} days: pick a shorter one.`,
    };
  }
  // Never reached with MAX_CUSTOM_POINTS far below it; kept so a change there cannot break Prometheus.
  if (source === 'prometheus' && fit.points > PROMETHEUS_MAX_POINTS) {
    return { problem: `Prometheus answers at most ${PROMETHEUS_MAX_POINTS} points per series.` };
  }

  const range: TrafficRange = {
    id: 'custom',
    label: `from ${labelTime(fit.from)} to ${labelTime(fit.to)} UTC`,
    durationSeconds: (fit.to - fit.from) / 1000,
    sourceSeconds: fit.step >= 3_600 ? 3_600 : 60,
    stepSeconds: fit.step,
    sources: [source],
    end: fit.to,
  };
  return { range, notes };
}
