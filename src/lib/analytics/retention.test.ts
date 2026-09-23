import { describe, expect, it } from 'vitest';
import { retainedRange, retentionNotes } from './retention';
import {
  TRAFFIC_RANGES,
  TRAFFIC_RANGE_IDS,
  offersRange,
  parseTrafficRange,
  rangesFor,
  trafficWindow,
} from './traffic';

const NOW = Date.parse('2026-09-23T12:34:56Z');
const DEFAULTS = { minuteRetentionDays: 3, hourRetentionDays: 90 };
const ROLLUPS = { source: 'rollups' as const, now: NOW, ...DEFAULTS };

describe('retentionNotes', () => {
  it('says nothing while minute retention covers the start', () => {
    expect(retentionNotes(NOW - 86_400_000, NOW, DEFAULTS)).toEqual({
      minuteRowsGone: false,
      notes: [],
    });
  });

  it('names both settings once the start outruns them', () => {
    const { minuteRowsGone, notes } = retentionNotes(NOW - 100 * 86_400_000, NOW, DEFAULTS);
    expect(minuteRowsGone).toBe(true);
    expect(notes[0]).toContain('G2_ANALYTICS_MINUTE_RETENTION_DAYS');
    expect(notes[0]).toContain('reads hour rollups');
    expect(notes[1]).toContain('G2_ANALYTICS_HOUR_RETENTION_DAYS');
    expect(notes[1]).toContain('nothing before 2026-06-25 12:34 UTC remains');
  });
});

describe('retainedRange', () => {
  it('leaves every rollup range alone under the default retention', () => {
    for (const id of rangesFor('rollups', DEFAULTS.hourRetentionDays)) {
      const result = retainedRange(TRAFFIC_RANGES[id], ROLLUPS);
      expect(result).toEqual({ range: TRAFFIC_RANGES[id], notes: [] });
    }
  });

  it('never truncates 24h at the smallest minute retention the config accepts', () => {
    // G2_ANALYTICS_MINUTE_RETENTION_DAYS is at least 1 (config.ts), and the
    // 24h window always starts after now - 24h.
    const result = retainedRange(TRAFFIC_RANGES['24h'], { ...ROLLUPS, minuteRetentionDays: 1 });
    expect(result.range.sourceSeconds).toBe(60);
    expect(result.notes).toEqual([]);
  });

  it('reads hour rows, at hour steps or more, when minute retention is shorter than the range', () => {
    // Not reachable with today's integer-day settings for these ranges, but
    // the switch must hold if a range grows or the bound changes.
    const result = retainedRange(TRAFFIC_RANGES['24h'], { ...ROLLUPS, minuteRetentionDays: 0.5 });
    expect(result.range).toMatchObject({ id: '24h', sourceSeconds: 3_600, stepSeconds: 3_600 });
    expect(trafficWindow(result.range, NOW).points).toBe(24);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('reads hour rollups');
  });

  it('says so when hour retention is shorter than an hour-row range', () => {
    const result = retainedRange(TRAFFIC_RANGES['30d'], { ...ROLLUPS, hourRetentionDays: 7 });
    expect(result.range).toBe(TRAFFIC_RANGES['30d']);
    expect(result.notes).toEqual([
      expect.stringContaining('Hour rollups are kept 7 days (G2_ANALYTICS_HOUR_RETENTION_DAYS)'),
    ]);
  });

  it('leaves Prometheus ranges alone', () => {
    const tight = {
      source: 'prometheus' as const,
      now: NOW,
      minuteRetentionDays: 1,
      hourRetentionDays: 1,
    };
    expect(retainedRange(TRAFFIC_RANGES['1y'], tight)).toEqual({
      range: TRAFFIC_RANGES['1y'],
      notes: [],
    });
  });
});

describe('offersRange', () => {
  it('offers 90d from the rollups when hour retention holds its whole window', () => {
    expect(rangesFor('rollups')).toEqual(['1h', '6h', '24h', '7d', '30d']);
    expect(rangesFor('rollups', 89)).toEqual(['1h', '6h', '24h', '7d', '30d']);
    expect(rangesFor('rollups', 90)).toEqual(['1h', '6h', '24h', '7d', '30d', '90d']);
    expect(rangesFor('rollups', 365)).toEqual(TRAFFIC_RANGE_IDS);
    expect(parseTrafficRange('90d', 'rollups', 90).id).toBe('90d');
    expect(parseTrafficRange('1y', 'rollups', 90).id).toBe('1h');
  });

  it('keeps the always-offered ranges whatever the retention (they say what was pruned)', () => {
    expect(offersRange('30d', 'rollups', 1)).toBe(true);
    expect(offersRange('1y', 'prometheus')).toBe(true);
  });

  it('holds 90d from the rollups without a pruned note at exactly 90 days', () => {
    const result = retainedRange(parseTrafficRange('90d', 'rollups', 90), ROLLUPS);
    expect(result.notes).toEqual([]);
    expect(trafficWindow(result.range, NOW).from).toBeGreaterThan(NOW - 90 * 86_400_000);
  });
});
