import { describe, expect, it } from 'vitest';
import {
  allowedBreakdowns,
  breakdownPlan,
  breakdownSeries,
  describeValue,
  drillHref,
  exportHref,
  focusSelection,
  groupFocus,
  parseDrill,
  rangeHrefs,
  sourceHref,
  subtractBucket,
  totalOf,
  trafficHref,
} from './drill';
import { TRAFFIC_RANGES, emptyBucket, type TrafficBucket } from './traffic';

const KEYS = { keys: true };

function bucket(
  start: number,
  requests: number,
  extra: Partial<TrafficBucket> = {},
): TrafficBucket {
  return { ...emptyBucket(start), requests, status2xx: requests, ...extra };
}

describe('parseDrill', () => {
  it('defaults to every API, broken down by API', () => {
    expect(parseDrill({}, KEYS)).toEqual({ apiId: null, focus: null, by: 'api', notes: [] });
  });

  it('reads an API, one focus and a breakdown', () => {
    expect(parseDrill({ api: 'users', by: 'path' }, KEYS)).toMatchObject({
      apiId: 'users',
      focus: null,
      by: 'path',
    });
    expect(parseDrill({ status: '5xx', by: 'status' }, KEYS)).toMatchObject({
      focus: { dimension: 'status', value: '5xx' },
      by: 'status',
      notes: [],
    });
    expect(parseDrill({ method: ['POST', 'GET'] }, KEYS).focus).toEqual({
      dimension: 'method',
      value: 'POST',
    });
    expect(parseDrill({ path: '(other)' }, KEYS).focus).toEqual({
      dimension: 'path',
      value: '(other)',
    });
  });

  it('treats an empty key as the keyless requests', () => {
    expect(parseDrill({ key: '' }, KEYS).focus).toEqual({ dimension: 'key', value: '' });
    expect(parseDrill({ method: '' }, KEYS).focus).toBeNull();
  });

  it('keeps one focus and says why it dropped another', () => {
    const drill = parseDrill({ key: 'abc', path: '/users' }, KEYS);
    expect(drill.focus).toEqual({ dimension: 'key', value: 'abc' });
    expect(drill.notes).toEqual([expect.stringMatching(/^path: ignored.*one dimension per row/)]);
  });

  it('refuses malformed values, with a note', () => {
    const drill = parseDrill({ status: '600', method: 'GE T', path: 'users' }, KEYS);
    expect(drill.focus).toBeNull();
    expect(drill.notes).toHaveLength(3);
    expect(parseDrill({ api: 'a\nb' }, KEYS)).toMatchObject({
      apiId: null,
      notes: [expect.any(String)],
    });
  });

  it('ignores key drill-down without keys:read', () => {
    expect(parseDrill({ key: 'abc' }, { keys: false })).toMatchObject({
      focus: null,
      notes: ['key: needs the keys:read permission; ignored.'],
    });
    expect(parseDrill({ by: 'key' }, { keys: false })).toMatchObject({
      by: 'api',
      notes: [expect.stringMatching(/^by=key/)],
    });
  });

  it('falls back to the first breakdown the selection can answer', () => {
    expect(parseDrill({ api: 'users', by: 'api' }, KEYS)).toMatchObject({ by: 'status' });
    expect(parseDrill({ api: 'users', key: 'k1' }, KEYS)).toMatchObject({ by: null, notes: [] });
    expect(parseDrill({ key: 'k1', by: 'path' }, KEYS)).toMatchObject({
      by: 'api',
      notes: [expect.stringMatching(/^by=path/)],
    });
  });
});

describe('allowedBreakdowns', () => {
  it('offers every dimension without a focus, and only answerable ones with one', () => {
    expect(allowedBreakdowns({ apiId: null, focus: null }, KEYS)).toEqual([
      'api',
      'status',
      'method',
      'path',
      'key',
    ]);
    expect(allowedBreakdowns({ apiId: 'users', focus: null }, { keys: false })).toEqual([
      'status',
      'method',
      'path',
    ]);
    expect(
      allowedBreakdowns({ apiId: null, focus: { dimension: 'method', value: 'GET' } }, KEYS),
    ).toEqual(['api']);
    expect(
      allowedBreakdowns({ apiId: 'users', focus: { dimension: 'status', value: '4xx' } }, KEYS),
    ).toEqual(['status']);
    expect(
      allowedBreakdowns({ apiId: 'users', focus: { dimension: 'status', value: '404' } }, KEYS),
    ).toEqual([]);
  });
});

describe('selections', () => {
  it('turns a focus into rollup rows', () => {
    expect(focusSelection(null)).toEqual({});
    expect(focusSelection({ dimension: 'status', value: '5xx' })).toEqual({
      dimension: 'status',
      statusClass: 5,
    });
    expect(focusSelection({ dimension: 'status', value: '503' })).toEqual({
      dimension: 'status',
      value: '503',
    });
    expect(focusSelection({ dimension: 'key', value: '' })).toEqual({
      dimension: 'key',
      value: '',
    });
  });

  it('plans each breakdown on rows the rollups hold', () => {
    expect(breakdownPlan({ focus: null }, 'api')).toEqual({
      selection: { dimension: 'api' },
      group: 'api',
    });
    expect(breakdownPlan({ focus: { dimension: 'key', value: 'k1' } }, 'api')).toEqual({
      selection: { dimension: 'key', value: 'k1' },
      group: 'api',
    });
    expect(breakdownPlan({ focus: null }, 'status')).toEqual({
      selection: { dimension: 'status' },
      group: 'class',
    });
    expect(breakdownPlan({ focus: { dimension: 'status', value: '5xx' } }, 'status')).toEqual({
      selection: { dimension: 'status', statusClass: 5 },
      group: 'value',
    });
    expect(breakdownPlan({ focus: null }, 'path')).toEqual({
      selection: { dimension: 'path' },
      group: 'value',
    });
  });

  it('drills a breakdown group into a focus', () => {
    expect(groupFocus('status', 'class', '5')).toEqual({ dimension: 'status', value: '5xx' });
    expect(groupFocus('status', 'value', '503')).toEqual({ dimension: 'status', value: '503' });
    expect(groupFocus('key', 'value', '')).toEqual({ dimension: 'key', value: '' });
  });
});

describe('hrefs', () => {
  it('writes every part of the state, encoded, in a fixed order', () => {
    expect(
      drillHref({
        range: '6h',
        apiId: 'a b',
        focus: { dimension: 'path', value: '/x?y=1&z' },
        by: 'api',
      }),
    ).toBe('/analytics?range=6h&api=a+b&path=%2Fx%3Fy%3D1%26z&by=api');
    expect(
      drillHref({ range: '1h', apiId: null, focus: { dimension: 'key', value: '' }, by: null }),
    ).toBe('/analytics?range=1h&key=');
  });

  it('links an API or a key to its traffic', () => {
    expect(trafficHref({ api: 'users' })).toBe('/analytics?range=1h&api=users');
    expect(trafficHref({ key: 'ab/c' })).toBe('/analytics?range=1h&key=ab%2Fc');
  });

  it('keeps the drill-down across ranges', () => {
    const hrefs = rangeHrefs({ apiId: 'users', focus: null, by: 'path' });
    expect(hrefs['30d']).toBe('/analytics?range=30d&api=users&by=path');
    expect(Object.keys(hrefs)).toHaveLength(5);
  });

  it('round-trips through parseDrill', () => {
    const state = {
      range: '24h',
      apiId: 'users',
      focus: { dimension: 'status', value: '4xx' },
      by: 'status',
    } as const;
    const params = Object.fromEntries(new URL(drillHref(state), 'http://x').searchParams);
    expect(parseDrill(params, KEYS)).toEqual({
      apiId: 'users',
      focus: state.focus,
      by: 'status',
      notes: [],
    });
  });
});

describe('breakdownSeries', () => {
  const range = TRAFFIC_RANGES['1h'];
  const from = Date.UTC(2026, 8, 23, 10);
  const now = from + 3_600_000 - 1; // the last minute has 59.999 s gone; close enough to whole
  const at = (minute: number) => from + minute * 60_000;

  it('draws up to three groups on their own when they are all the traffic', () => {
    const series = breakdownSeries(
      range,
      now,
      [bucket(at(0), 120), bucket(at(1), 60)],
      [
        { label: 'users', buckets: [bucket(at(0), 60), bucket(at(1), 60)] },
        { label: 'orders', buckets: [bucket(at(0), 60)] },
      ],
    );
    expect(series.map((s) => [s.label, s.slot])).toEqual([
      ['users', 1],
      ['orders', 2],
    ]);
    expect(series[0].values.slice(0, 2)).toEqual([1, 1]);
    expect(series[1].values.slice(0, 2)).toEqual([1, 0]);
    expect(series[0].values).toHaveLength(60);
  });

  it('folds past two groups into "Everything else" when more traffic exists', () => {
    const series = breakdownSeries(
      range,
      now,
      [bucket(at(0), 240)],
      [
        { label: 'a', buckets: [bucket(at(0), 120)] },
        { label: 'b', buckets: [bucket(at(0), 60)] },
        { label: 'c', buckets: [bucket(at(0), 30)] },
      ],
    );
    expect(series.map((s) => [s.label, s.slot])).toEqual([
      ['a', 1],
      ['b', 2],
      ['Everything else', 3],
    ]);
    // 240 − 120 − 60 = 60 requests in the minute.
    expect(series[2].values[0]).toBe(1);
  });

  it('never draws more than three lines', () => {
    const groups = ['a', 'b', 'c', 'd'].map((label) => ({
      label,
      buckets: [bucket(at(0), 60)],
    }));
    expect(breakdownSeries(range, now, [bucket(at(0), 240)], groups)).toHaveLength(3);
  });
});

describe('bucket arithmetic', () => {
  it('totals and subtracts counters, keeping the total maximum', () => {
    const total = totalOf(
      [
        bucket(1, 10, { status5xx: 2, latencyMaxMs: 40, latencyLe50: 10 }),
        bucket(2, 5, { latencyMaxMs: 90, latencyLe100: 5 }),
      ],
      0,
    );
    expect(total).toMatchObject({ start: 0, requests: 15, status5xx: 2, latencyMaxMs: 90 });
    const rest = subtractBucket(total, [bucket(0, 10, { latencyLe50: 10, latencyMaxMs: 40 })]);
    expect(rest).toMatchObject({ requests: 5, status2xx: 5, latencyLe50: 0, latencyLe100: 5 });
    expect(rest.latencyMaxMs).toBe(90);
    expect(subtractBucket(total, [bucket(0, 99)]).requests).toBe(0);
  });
});

describe('describeValue', () => {
  const shortHash = (hash: string) => `${hash.slice(0, 4)}…`;
  it('names a key by label, then alias, then short hash', () => {
    expect(describeValue('key', 'abcdef', { keyLabel: 'Mobile', alias: 'm', shortHash })).toEqual({
      label: 'Mobile',
      detail: 'abcd…',
      mono: false,
    });
    expect(describeValue('key', 'abcdef', { alias: 'm', shortHash }).label).toBe('m');
    expect(describeValue('key', 'abcdef', { shortHash })).toEqual({
      label: 'abcd…',
      detail: null,
      mono: true,
    });
    expect(describeValue('key', '', { shortHash }).label).toBe('No key');
  });

  it('explains the folded paths', () => {
    expect(describeValue('path', '(other)', { shortHash }).label).toBe('Other paths');
    expect(describeValue('path', '/users', { shortHash })).toMatchObject({ mono: true });
  });
});

describe('the Prometheus source (ADR-0015 §4)', () => {
  const PROM = { keys: true, source: 'prometheus' } as const;

  it('narrows by API and status only, noting the rest', () => {
    expect(parseDrill({ api: 'users', status: '5xx' }, PROM)).toMatchObject({
      apiId: 'users',
      focus: { dimension: 'status', value: '5xx' },
      notes: [],
    });
    const drill = parseDrill({ method: 'GET', path: '/x', key: 'k' }, PROM);
    expect(drill.focus).toBeNull();
    expect(drill.notes).toHaveLength(3);
    expect(drill.notes[0]).toMatch(/^key: ignored, g2way's Prometheus metrics carry no key label/);
  });

  it('offers only the API and status breakdowns', () => {
    expect(allowedBreakdowns({ apiId: null, focus: null }, PROM)).toEqual(['api', 'status']);
    expect(allowedBreakdowns({ apiId: 'users', focus: null }, PROM)).toEqual(['status']);
    expect(
      allowedBreakdowns({ apiId: 'users', focus: { dimension: 'status', value: '5xx' } }, PROM),
    ).toEqual(['status']);
    expect(parseDrill({ by: 'path' }, PROM)).toMatchObject({
      by: 'api',
      notes: ['by=path: not a breakdown this selection can answer; ignored.'],
    });
  });

  it('carries the source in every href, and offers its own ranges', () => {
    const state = { source: 'prometheus', apiId: 'users', focus: null, by: 'status' } as const;
    expect(drillHref({ ...state, range: '1y' })).toBe(
      '/analytics?range=1y&source=prometheus&api=users&by=status',
    );
    expect(Object.keys(rangeHrefs(state))).toEqual(['1h', '6h', '24h', '7d', '30d', '90d', '1y']);
    expect(Object.keys(rangeHrefs({ ...state, source: 'rollups' }))).not.toContain('1y');
  });

  it('switches source keeping what the other source can answer', () => {
    const rollups = {
      range: '7d',
      apiId: 'users',
      focus: { dimension: 'method', value: 'GET' },
      by: null,
    } as const;
    expect(sourceHref(rollups, 'prometheus')).toBe(
      '/analytics?range=7d&source=prometheus&api=users',
    );
    const prom = {
      range: '1y',
      source: 'prometheus',
      apiId: null,
      focus: { dimension: 'status', value: '5xx' },
      by: 'status',
    } as const;
    // 1y is Prometheus's alone: back to the default range.
    expect(sourceHref(prom, 'rollups')).toBe('/analytics?range=1h&status=5xx&by=status');
  });
});

describe('exportHref', () => {
  it('names the table, then the view’s own parameters', () => {
    expect(
      exportHref(
        { range: '6h', source: 'prometheus', apiId: 'a', focus: null, by: 'status' },
        'breakdown',
      ),
    ).toBe('/api/analytics/export?table=breakdown&range=6h&source=prometheus&api=a&by=status');
  });
});
