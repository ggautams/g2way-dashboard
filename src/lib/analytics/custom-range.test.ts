import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_POINTS,
  customRange,
  formatUtcMinute,
  parseUtcMinute,
  readCustomWindow,
  type CustomRangeContext,
} from './custom-range';
import { drillHref, parseDrill, selectionParams, sourceHref } from './drill';
import { emptyBucket, trafficSeries, trafficWindow } from './traffic';

const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-09-23T12:34:56Z');
const ROLLUPS: CustomRangeContext = {
  source: 'rollups',
  now: NOW,
  minuteRetentionDays: 3,
  hourRetentionDays: 90,
};
const PROM: CustomRangeContext = { ...ROLLUPS, source: 'prometheus' };

function ok(result: ReturnType<typeof customRange>) {
  if ('problem' in result) throw new Error(result.problem);
  return result;
}

function problem(result: ReturnType<typeof customRange>) {
  if (!('problem' in result)) throw new Error('expected a problem');
  return result.problem;
}

describe('UTC minutes', () => {
  it('reads datetime-local values, seconds, a trailing Z and bare dates as UTC', () => {
    expect(parseUtcMinute('2026-09-01T10:30')).toBe(at('2026-09-01T10:30:00Z'));
    expect(parseUtcMinute('2026-09-01T10:30:15Z')).toBe(at('2026-09-01T10:30:15Z'));
    expect(parseUtcMinute('2026-09-01 10:30')).toBe(at('2026-09-01T10:30:00Z'));
    expect(parseUtcMinute('2026-09-01')).toBe(at('2026-09-01T00:00:00Z'));
  });

  it('refuses anything else, impossible dates included', () => {
    for (const bad of [
      '',
      'yesterday',
      '2026-02-30',
      '2026-09-01T25:00',
      '1756684800',
      '2026-9-1',
    ]) {
      expect(parseUtcMinute(bad)).toBeNull();
    }
  });

  it('writes the same form back', () => {
    expect(formatUtcMinute(at('2026-01-02T03:04:59Z'))).toBe('2026-01-02T03:04');
  });
});

describe('readCustomWindow', () => {
  it('is nothing without from and to', () => {
    expect(readCustomWindow(undefined, undefined)).toBeNull();
    expect(readCustomWindow('', ' ')).toBeNull();
  });

  it('needs both, and both must parse', () => {
    expect(readCustomWindow('2026-09-01T00:00', undefined)).toEqual({
      problem: 'A custom range needs both a start (from) and an end (to).',
    });
    expect(readCustomWindow('2026-09-01T00:00', 'soon')).toEqual({
      problem: 'to=soon: not a UTC date and time (YYYY-MM-DDTHH:mm).',
    });
    expect(readCustomWindow('2026-09-01T00:00', '2026-09-02T00:00')).toEqual({
      window: { from: at('2026-09-01T00:00Z'), to: at('2026-09-02T00:00Z') },
    });
  });
});

describe('customRange', () => {
  it('refuses inverted, future and too-short windows, saying why', () => {
    const w = (from: string, to: string) => ({ from: at(from), to: at(to) });
    expect(problem(customRange(w('2026-09-22T00:00Z', '2026-09-21T00:00Z'), ROLLUPS))).toMatch(
      /ends before it starts/,
    );
    expect(problem(customRange(w('2026-09-22T00:00Z', '2026-09-22T00:00Z'), ROLLUPS))).toMatch(
      /ends before it starts/,
    );
    expect(problem(customRange(w('2026-09-24T00:00Z', '2026-09-25T00:00Z'), ROLLUPS))).toMatch(
      /starts in the future/,
    );
    expect(problem(customRange(w('2026-09-22T00:00Z', '2026-09-22T00:04Z'), ROLLUPS))).toMatch(
      /shorter than 5 minutes/,
    );
  });

  it('picks the shortest step that fits, reading minute rows for recent sub-hour steps', () => {
    const { range, notes } = ok(
      customRange({ from: at('2026-09-22T00:00Z'), to: at('2026-09-22T02:00Z') }, ROLLUPS),
    );
    expect(range).toMatchObject({ id: 'custom', stepSeconds: 60, sourceSeconds: 60 });
    expect(range.durationSeconds).toBe(7_200);
    expect(range.label).toBe('from 2026-09-22 00:00 to 2026-09-22 02:00 UTC');
    expect(notes).toEqual([]);

    const day = ok(
      customRange({ from: at('2026-09-22T00:00Z'), to: at('2026-09-23T00:00Z') }, ROLLUPS),
    );
    expect(day.range).toMatchObject({ stepSeconds: 300, sourceSeconds: 60 });
  });

  it('aligns the window to the step and keeps at most MAX_CUSTOM_POINTS', () => {
    const { range } = ok(
      customRange({ from: at('2026-06-01T00:07Z'), to: at('2026-08-31T13:00Z') }, ROLLUPS),
    );
    const window = trafficWindow(range, NOW);
    expect(window.points).toBeLessThanOrEqual(MAX_CUSTOM_POINTS);
    expect(window.from % window.stepMs).toBe(0);
    expect(window.from).toBeLessThanOrEqual(at('2026-06-01T00:07Z'));
    expect(window.to).toBeGreaterThanOrEqual(at('2026-08-31T13:00Z'));
    expect(range.end).toBe(window.to);
  });

  it('reads hour rows when the window starts before minute retention, and says so', () => {
    const { range, notes } = ok(
      customRange({ from: at('2026-09-10T00:00Z'), to: at('2026-09-10T02:00Z') }, ROLLUPS),
    );
    expect(range).toMatchObject({ stepSeconds: 3_600, sourceSeconds: 3_600 });
    expect(notes).toEqual([expect.stringMatching(/Minute rollups are kept 3 days/)]);
  });

  it('warns when the window starts before hour retention', () => {
    const { notes } = ok(
      customRange({ from: at('2026-01-01T00:00Z'), to: at('2026-02-01T00:00Z') }, ROLLUPS),
    );
    expect(notes).toContainEqual(expect.stringMatching(/Hour rollups are kept 90 days/));
  });

  it('ends a window reaching into the future now, still filling', () => {
    const { range, notes } = ok(
      customRange({ from: at('2026-09-23T10:00Z'), to: at('2026-09-24T00:00Z') }, ROLLUPS),
    );
    expect(notes).toEqual(['to=2026-09-24T00:00 is in the future; the range ends now.']);
    const traffic = trafficSeries(range, [], NOW);
    expect(traffic.filling).toBe(true);
    expect(traffic.to).toBeGreaterThan(NOW);
    expect(traffic.to - NOW).toBeLessThan(range.stepSeconds * 1000);
  });

  it('draws a window in the past whole, with nothing still filling', () => {
    const { range } = ok(
      customRange({ from: at('2026-09-22T00:00Z'), to: at('2026-09-22T01:00Z') }, ROLLUPS),
    );
    const bucket = { ...emptyBucket(at('2026-09-22T00:30Z')), requests: 60 };
    const traffic = trafficSeries(range, [bucket], NOW);
    expect(traffic.filling).toBe(false);
    expect(traffic.points).toHaveLength(60);
    expect(traffic.summary.requests).toBe(60);
    // The whole hour elapsed: 60 requests over 3600 s.
    expect(traffic.summary.rps).toBeCloseTo(60 / 3_600);
  });

  it('refuses a window longer than the chart can draw', () => {
    expect(
      problem(customRange({ from: at('2024-01-01T00:00Z'), to: at('2026-01-01T00:00Z') }, PROM)),
    ).toMatch(/longer than 400 days/);
  });

  it('keeps two scrapes per step under Prometheus, and no retention notes', () => {
    const { range, notes } = ok(
      customRange({ from: at('2026-09-01T00:00Z'), to: at('2026-09-01T01:00Z') }, PROM),
    );
    expect(range.stepSeconds).toBe(120);
    expect(range.sources).toEqual(['prometheus']);
    expect(notes).toEqual([]);
  });
});

describe('custom windows in the URL', () => {
  const window = { from: at('2026-09-01T00:00Z'), to: at('2026-09-02T12:30Z') };

  it('writes from and to in place of range, the rest in the usual order', () => {
    expect(
      drillHref({ range: window, source: 'prometheus', apiId: 'a', focus: null, by: 'status' }),
    ).toBe(
      '/analytics?from=2026-09-01T00%3A00&to=2026-09-02T12%3A30&source=prometheus&api=a&by=status',
    );
  });

  it('keeps the selection, but never the range, in the form’s hidden fields', () => {
    expect(
      selectionParams({ apiId: 'a', focus: { dimension: 'status', value: '5xx' }, by: null }),
    ).toEqual([
      ['api', 'a'],
      ['status', '5xx'],
    ]);
  });

  it('keeps a custom window across a source switch', () => {
    const state = { range: window, apiId: null, focus: null, by: null };
    expect(sourceHref(state, 'prometheus')).toBe(
      '/analytics?from=2026-09-01T00%3A00&to=2026-09-02T12%3A30&source=prometheus',
    );
  });

  it('round-trips through readCustomWindow and parseDrill', () => {
    const state = { range: window, apiId: 'users', focus: null, by: 'path' } as const;
    const params = Object.fromEntries(new URL(drillHref(state), 'http://x').searchParams);
    expect(readCustomWindow(params.from, params.to)).toEqual({ window });
    expect(parseDrill(params, { keys: true })).toMatchObject({ apiId: 'users', by: 'path' });
  });
});
