import { describe, expect, it } from 'vitest';
import { latencyBucketOf } from './rollup';
import {
  TRAFFIC_RANGES,
  emptyBucket,
  estimatePercentile,
  parseTrafficRange,
  resample,
  trafficSeries,
  trafficWindow,
  type TrafficBucket,
} from './traffic';

/** A bucket holding exactly these latencies, as the ingest worker would fold them. */
function bucketOf(start: number, latencies: number[], statuses: number[] = []): TrafficBucket {
  const bucket = emptyBucket(start);
  latencies.forEach((latency, i) => {
    bucket.requests += 1;
    bucket.latencySumMs += latency;
    bucket.latencyMaxMs = Math.max(bucket.latencyMaxMs, latency);
    bucket[latencyBucketOf(latency)] += 1;
    const status = statuses[i] ?? 200;
    if (status >= 500) bucket.status5xx += 1;
    else if (status >= 400) bucket.status4xx += 1;
    else bucket.status2xx += 1;
  });
  return bucket;
}

const MIN = 60_000;
// 2026-09-23 10:30:20 UTC: 20 s into a minute, 30m20s into the hour.
const NOW = Date.UTC(2026, 8, 23, 10, 30, 20);

describe('estimatePercentile', () => {
  it('is null without requests', () => {
    expect(estimatePercentile(emptyBucket(0), 0.5)).toBeNull();
  });

  it('interpolates linearly inside the bucket holding the rank', () => {
    // 100 requests, all in (25, 50]; the max narrows the top to 45.
    const bucket = bucketOf(
      0,
      Array.from({ length: 100 }, () => 45),
    );
    bucket.latencyMaxMs = 45;
    expect(estimatePercentile(bucket, 0.5)).toBeCloseTo(25 + 20 * 0.5);
    expect(estimatePercentile(bucket, 0.99)).toBeCloseTo(25 + 20 * 0.99);
    expect(estimatePercentile(bucket, 1)).toBe(45);
  });

  it('walks the cumulative counts across buckets', () => {
    // 90 fast (≤ 1 ms), 9 in (50, 100], 1 in (250, 500] with max 400.
    const latencies = [
      ...Array.from({ length: 90 }, () => 1),
      ...Array.from({ length: 9 }, () => 80),
      400,
    ];
    const bucket = bucketOf(0, latencies);
    expect(estimatePercentile(bucket, 0.5)).toBeCloseTo((50 / 90) * 1);
    // rank 95 is the 5th of 9 in (50, 100]; that bucket is not the max's, so its top is 100.
    expect(estimatePercentile(bucket, 0.95)).toBeCloseTo(50 + 50 * (5 / 9));
    // rank 99 is exactly the end of (50, 100].
    expect(estimatePercentile(bucket, 0.99)).toBeCloseTo(100);
    expect(estimatePercentile(bucket, 0.999)).toBeCloseTo(250 + (400 - 250) * 0.9);
  });

  it('stays within the true bucket of an exact percentile', () => {
    const latencies = Array.from({ length: 1000 }, (_, i) => (i * 37) % 3000);
    const sorted = [...latencies].sort((a, b) => a - b);
    const bucket = bucketOf(0, latencies);
    for (const q of [0.5, 0.95, 0.99]) {
      const exact = sorted[Math.ceil(q * sorted.length) - 1];
      const estimate = estimatePercentile(bucket, q) ?? Number.NaN;
      expect(latencyBucketOf(Math.ceil(estimate))).toBe(latencyBucketOf(exact));
    }
  });

  it('bounds the open-ended overflow bucket by the maximum', () => {
    const bucket = bucketOf(0, [12_000, 20_000]);
    expect(estimatePercentile(bucket, 0.5)).toBeCloseTo(10_000 + 10_000 * 0.5);
    expect(estimatePercentile(bucket, 1)).toBe(20_000);
  });

  it('falls back to the bounds when the max disagrees with the histogram', () => {
    const bucket = bucketOf(0, [80, 80]);
    bucket.latencyMaxMs = 3;
    expect(estimatePercentile(bucket, 1)).toBe(100);
  });
});

describe('ranges and windows', () => {
  it('parses a known range and defaults anything else', () => {
    expect(parseTrafficRange('7d').id).toBe('7d');
    expect(parseTrafficRange('forever').id).toBe('1h');
    expect(parseTrafficRange(undefined).id).toBe('1h');
    expect(parseTrafficRange(['6h']).id).toBe('1h');
  });

  it('every step is a whole multiple of its source granularity', () => {
    for (const range of Object.values(TRAFFIC_RANGES)) {
      expect(range.stepSeconds % range.sourceSeconds).toBe(0);
      expect(range.durationSeconds % range.stepSeconds).toBe(0);
    }
  });

  it('ends the window at the end of the step containing now', () => {
    const window = trafficWindow(TRAFFIC_RANGES['1h'], NOW);
    expect(window.to).toBe(Date.UTC(2026, 8, 23, 10, 31));
    expect(window.from).toBe(Date.UTC(2026, 8, 23, 9, 31));
    expect(window.points).toBe(60);
    const day = trafficWindow(TRAFFIC_RANGES['24h'], NOW);
    expect(day.to).toBe(Date.UTC(2026, 8, 23, 10, 45));
    expect(day.points).toBe(96);
  });
});

describe('resample', () => {
  it('sums source buckets into steps, gap-fills, and drops what is outside', () => {
    const from = Date.UTC(2026, 8, 23, 10, 0);
    const steps = resample(
      [
        bucketOf(from, [10, 20]),
        bucketOf(from + 4 * MIN, [300], [500]),
        bucketOf(from + 10 * MIN, [1]),
        bucketOf(from - MIN, [1]),
        bucketOf(from + 15 * MIN, [1]),
      ],
      { from, stepMs: 5 * MIN, points: 3 },
    );
    expect(steps.map((s) => s.start)).toEqual([from, from + 5 * MIN, from + 10 * MIN]);
    expect(steps.map((s) => s.requests)).toEqual([3, 0, 1]);
    expect(steps[0]).toMatchObject({
      status2xx: 2,
      status5xx: 1,
      latencySumMs: 330,
      latencyMaxMs: 300,
      latencyLe10: 1,
      latencyLe25: 1,
      latencyLe500: 1,
    });
  });
});

describe('trafficSeries', () => {
  it('derives RPS, error rates and percentiles per step and over the range', () => {
    const range = TRAFFIC_RANGES['1h'];
    const current = Date.UTC(2026, 8, 23, 10, 30);
    const series = trafficSeries(
      range,
      [
        // A full minute: 120 requests, 6 of them 5xx and 12 4xx.
        bucketOf(
          current - MIN,
          Array.from({ length: 120 }, () => 20),
          [...Array.from({ length: 6 }, () => 503), ...Array.from({ length: 12 }, () => 404)],
        ),
        // The minute still filling: 20 s elapsed, 10 requests.
        bucketOf(
          current,
          Array.from({ length: 10 }, () => 3),
        ),
      ],
      NOW,
    );
    expect(series.points).toHaveLength(60);
    const full = series.points.at(-2)!;
    const partial = series.points.at(-1)!;
    expect(full).toMatchObject({ requests: 120, seconds: 60, rps: 2 });
    expect(full.serverErrorRate).toBeCloseTo(0.05);
    expect(full.clientErrorRate).toBeCloseTo(0.1);
    expect(partial).toMatchObject({ requests: 10, seconds: 20, rps: 0.5, serverErrorRate: 0 });
    // An empty step has zero rate but no latency or error figure.
    expect(series.points[0]).toMatchObject({
      requests: 0,
      rps: 0,
      serverErrorRate: null,
      p50: null,
    });

    const { summary } = series;
    expect(summary.requests).toBe(130);
    // 59 full minutes plus the 20 s of the current one.
    expect(summary.seconds).toBe(59 * 60 + 20);
    expect(summary.rps).toBeCloseTo(130 / (59 * 60 + 20));
    expect(summary.serverErrorRate).toBeCloseTo(6 / 130);
    expect(summary.latencyAvgMs).toBeCloseTo((120 * 20 + 10 * 3) / 130);
    expect(summary.latencyMaxMs).toBe(20);
    // 10 of 130 are ≤ 5 ms, so the median sits in (10, 25].
    expect(summary.p50).toBeGreaterThan(10);
    expect(summary.p50).toBeLessThanOrEqual(20);
  });

  it('reports no latency or max without traffic', () => {
    const { summary } = trafficSeries(TRAFFIC_RANGES['7d'], [], NOW);
    expect(summary).toMatchObject({ requests: 0, rps: 0, latencyAvgMs: null, latencyMaxMs: null });
  });
});
