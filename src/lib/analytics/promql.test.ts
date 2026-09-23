import { describe, expect, it } from 'vitest';
import {
  G2_DURATION_BOUNDS_SECONDS,
  breakdownTotals,
  bucketsFromMatrices,
  promSelector,
  quoteLabelValue,
  trafficQueries,
  type PromSeries,
  type TrafficMatrices,
} from './promql';
import { estimatePercentile, trafficSeries, TRAFFIC_RANGES } from './traffic';

const SELECTION = { orgId: 'acme', apiId: null, status: null, extra: null };

describe('promSelector', () => {
  it('always scopes to the org (ADR-0007)', () => {
    expect(promSelector(SELECTION)).toBe('{g2_org_id="acme"}');
  });

  it('adds the API, a status class or code, and the environment matchers', () => {
    expect(
      promSelector({ orgId: 'acme', apiId: 'users', status: '5xx', extra: 'job="g2way-prod"' }),
    ).toBe(
      '{g2_org_id="acme",g2_api_id="users",http_response_status_code=~"5..",job="g2way-prod"}',
    );
    expect(promSelector({ ...SELECTION, status: '503' })).toBe(
      '{g2_org_id="acme",http_response_status_code="503"}',
    );
  });

  it('escapes label values, so an API id cannot break out of its matcher', () => {
    expect(quoteLabelValue('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(promSelector({ ...SELECTION, apiId: 'x"} or vector(1) #' })).toBe(
      '{g2_org_id="acme",g2_api_id="x\\"} or vector(1) #"}',
    );
  });
});

describe('trafficQueries', () => {
  const selector = '{g2_org_id="acme"}';

  it('sums increase() over one step, by status code, le, or nothing', () => {
    expect(trafficQueries(selector, 3600, null)).toEqual({
      count:
        'sum by (http_response_status_code) (increase(http_server_request_duration_seconds_count{g2_org_id="acme"}[3600s]))',
      bucket:
        'sum by (le) (increase(http_server_request_duration_seconds_bucket{g2_org_id="acme"}[3600s]))',
      sum: 'sum (increase(http_server_request_duration_seconds_sum{g2_org_id="acme"}[3600s]))',
    });
  });

  it('adds the grouping label, once', () => {
    const byApi = trafficQueries(selector, 60, { group: 'api', dimension: 'api' });
    expect(byApi.count).toMatch(/^sum by \(g2_api_id, http_response_status_code\) /);
    expect(byApi.bucket).toMatch(/^sum by \(g2_api_id, le\) /);
    expect(byApi.sum).toMatch(/^sum by \(g2_api_id\) /);
    const byClass = trafficQueries(selector, 60, { group: 'class', dimension: 'status' });
    expect(byClass.count).toMatch(/^sum by \(http_response_status_code\) /);
    expect(byClass.bucket).toMatch(/^sum by \(http_response_status_code, le\) /);
  });
});

const T = 1_790_000_000; // a Unix second on a 60 s boundary
const STEP = 60;

/** Cumulative bucket series for one step, from per-le cumulative counts. */
function histogram(t: number, cumulative: Record<string, number>, metric = {}): PromSeries[] {
  return Object.entries(cumulative).map(([le, n]) => ({
    metric: { ...metric, le },
    values: [[t, String(n)]],
  }));
}

function matrices(parts: Partial<TrafficMatrices>): TrafficMatrices {
  return { count: [], bucket: [], sum: [], ...parts };
}

describe('bucketsFromMatrices', () => {
  it('reads a sample at t as the step [t − step, t), and folds codes into classes', () => {
    const out = bucketsFromMatrices(
      matrices({
        count: [
          { metric: { http_response_status_code: '200' }, values: [[T, '90.4']] },
          { metric: { http_response_status_code: '204' }, values: [[T, '5']] },
          { metric: { http_response_status_code: '404' }, values: [[T, '3.6']] },
          { metric: { http_response_status_code: '503' }, values: [[T, '1']] },
          { metric: { http_response_status_code: '999' }, values: [[T, '2']] },
        ],
        sum: [{ metric: {}, values: [[T, '2.5']] }],
      }),
      STEP,
      null,
    );
    const [bucket] = out.get('')!;
    expect(bucket.start).toBe((T - STEP) * 1000);
    // Rounded per class, since increase() extrapolates; odd codes count as requests only.
    expect(bucket).toMatchObject({
      status2xx: 95,
      status4xx: 4,
      status5xx: 1,
      requests: 102,
      latencySumMs: 2500,
    });
  });

  it('re-buckets the histogram onto the rollup bounds (ADR-0015 §3)', () => {
    const out = bucketsFromMatrices(
      matrices({
        count: [{ metric: { http_response_status_code: '200' }, values: [[T, '100']] }],
        bucket: histogram(T, {
          '0.005': 10,
          '0.01': 20,
          '0.025': 30,
          '0.05': 40,
          '0.075': 50, // merges into the 100 ms rollup bucket
          '0.1': 60,
          '0.25': 70,
          '0.5': 80,
          '0.75': 85,
          '1': 90,
          '2.5': 92,
          '5': 94,
          '7.5': 95,
          '10': 96,
          '+Inf': 100,
        }),
      }),
      STEP,
      null,
    );
    const [b] = out.get('')!;
    // Nothing is known below 5 ms.
    expect([b.latencyLe1, b.latencyLe2, b.latencyLe5]).toEqual([0, 0, 10]);
    expect([b.latencyLe10, b.latencyLe25, b.latencyLe50, b.latencyLe100]).toEqual([10, 10, 10, 20]);
    expect([b.latencyLe250, b.latencyLe500, b.latencyLe1000]).toEqual([10, 10, 10]);
    expect([b.latencyLe2500, b.latencyLe5000, b.latencyLe10000]).toEqual([2, 2, 2]);
    expect(b.latencyOver).toBe(4);
    // No maximum in the metric: the open bucket's estimate is its lower bound.
    expect(b.latencyMaxMs).toBe(10_000);
    expect(estimatePercentile(b, 0.99)).toBe(10_000);
    // Rank 50 falls halfway through the 50–100 ms bucket (40 below it, 20 in it).
    expect(estimatePercentile(b, 0.5)).toBeCloseTo(75, 5);
  });

  it('interpolates the first bucket from 2 ms, and caps at the highest non-empty bound', () => {
    const out = bucketsFromMatrices(
      matrices({
        count: [{ metric: { http_response_status_code: '200' }, values: [[T, '10']] }],
        bucket: histogram(T, { '0.005': 10, '0.01': 10, '+Inf': 10 }),
      }),
      STEP,
      null,
    );
    const [b] = out.get('')!;
    expect(b.latencyMaxMs).toBe(5);
    expect(estimatePercentile(b, 0.5)).toBeCloseTo(3.5, 5);
  });

  it('clamps a cumulative count that decreases, as extrapolation can make it', () => {
    const out = bucketsFromMatrices(
      matrices({
        count: [{ metric: { http_response_status_code: '200' }, values: [[T, '10']] }],
        bucket: histogram(T, { '0.005': 6, '0.01': 5.4, '+Inf': 10 }),
      }),
      STEP,
      null,
    );
    const [b] = out.get('')!;
    expect(b.latencyLe5).toBe(6);
    expect(b.latencyLe10).toBe(0);
    expect(b.latencyOver).toBe(4);
  });

  it('skips NaN, infinite and negative samples', () => {
    const out = bucketsFromMatrices(
      matrices({
        count: [
          {
            metric: { http_response_status_code: '200' },
            values: [
              [T, 'NaN'],
              [T + STEP, '+Inf'],
              [T + 2 * STEP, '-1'],
              [T + 3 * STEP, '7'],
            ],
          },
        ],
      }),
      STEP,
      null,
    );
    expect(out.get('')!.map((b) => b.requests)).toEqual([7]);
  });

  it('groups by API, status class or code, and leaves out groups without requests', () => {
    const count = [
      { metric: { g2_api_id: 'users', http_response_status_code: '200' }, values: [[T, '4']] },
      { metric: { g2_api_id: 'users', http_response_status_code: '502' }, values: [[T, '1']] },
      { metric: { g2_api_id: 'orders', http_response_status_code: '200' }, values: [[T, '0']] },
    ] satisfies PromSeries[];
    const byApi = bucketsFromMatrices(matrices({ count }), STEP, {
      group: 'api',
      dimension: 'api',
    });
    expect([...byApi.keys()]).toEqual(['users']);
    expect(byApi.get('users')![0]).toMatchObject({ requests: 5, status5xx: 1 });

    const byClass = bucketsFromMatrices(matrices({ count }), STEP, {
      group: 'class',
      dimension: 'status',
    });
    expect(Object.fromEntries([...byClass].map(([k, v]) => [k, v[0].requests]))).toEqual({
      '2': 4,
      '5': 1,
    });

    const byCode = bucketsFromMatrices(matrices({ count }), STEP, {
      group: 'value',
      dimension: 'status',
    });
    expect([...byCode.keys()].sort()).toEqual(['200', '502']);
  });

  it('feeds trafficSeries unchanged, one point per step', () => {
    const range = TRAFFIC_RANGES['1y'];
    const now = Date.UTC(2026, 8, 23, 12);
    const day = 86_400;
    const lastEnd = Math.floor(now / 1000 / day) * day + day;
    const out = bucketsFromMatrices(
      matrices({
        count: [
          {
            metric: { http_response_status_code: '200' },
            values: [
              [lastEnd - day, '864'],
              [lastEnd, '432'],
            ],
          },
        ],
      }),
      day,
      null,
    );
    const traffic = trafficSeries(range, out.get('')!, now, { exactMax: false });
    expect(traffic.points).toHaveLength(365);
    expect(traffic.points.at(-2)!.rps).toBeCloseTo(0.01, 10);
    // Half the last day has elapsed: 432 requests over 43 200 s.
    expect(traffic.points.at(-1)!.rps).toBeCloseTo(0.01, 10);
    expect(traffic.summary.requests).toBe(1296);
    expect(traffic.summary.latencyMaxMs).toBeNull();
  });
});

describe('breakdownTotals', () => {
  it('sums each group over the window, busiest first, ties by group', () => {
    const groups = bucketsFromMatrices(
      matrices({
        count: [
          { metric: { g2_api_id: 'b', http_response_status_code: '200' }, values: [[T, '3']] },
          { metric: { g2_api_id: 'a', http_response_status_code: '200' }, values: [[T, '3']] },
          {
            metric: { g2_api_id: 'c', http_response_status_code: '500' },
            values: [
              [T, '2'],
              [T + STEP, '2'],
            ],
          },
        ],
      }),
      STEP,
      { group: 'api', dimension: 'api' },
    );
    const rows = breakdownTotals(groups, 2);
    expect(rows.map((row) => [row.group, row.requests, row.label])).toEqual([
      ['c', 4, null],
      ['a', 3, null],
    ]);
    expect(rows[0]).toMatchObject({ status5xx: 4 });
    expect(rows[0]).not.toHaveProperty('start');
  });
});

it('mirrors g2way’s bucket bounds, which the rollup bounds mostly include', () => {
  // A tripwire beside the `metrics` watch area: if g2way's bounds move, the
  // re-bucketing notes in ADR-0015 §3 need a look.
  expect(G2_DURATION_BOUNDS_SECONDS.map((s) => Math.round(s * 1000))).toEqual([
    5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
  ]);
});
