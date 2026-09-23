import { describe, expect, it } from 'vitest';
import {
  BREAKDOWN_HEADER,
  SERIES_HEADER,
  breakdownRows,
  csvCell,
  exportFileName,
  seriesRows,
  toCsv,
} from './csv';
import { TRAFFIC_RANGES, emptyBucket, type TrafficBucket } from './traffic';

const at = (iso: string) => Date.parse(iso);

function bucket(start: number, fields: Partial<TrafficBucket>): TrafficBucket {
  return { ...emptyBucket(start), ...fields };
}

describe('csvCell', () => {
  it('defuses anything a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
  });

  it('quotes commas, quotes and line breaks, and leaves plain text alone', () => {
    expect(csvCell('/users/{id}')).toBe('/users/{id}');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it('writes numbers as they are and nothing for null or non-finite', () => {
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(0.25)).toBe('0.25');
    expect(csvCell(null)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });
});

describe('toCsv', () => {
  it('opens with # rows, whose values are defused too, and ends lines with CRLF', () => {
    expect(toCsv([['api', '=evil']], ['a', 'b'], [[1, 'x']])).toBe(
      "# api,'=evil\r\na,b\r\n1,x\r\n",
    );
  });
});

describe('seriesRows', () => {
  const range = TRAFFIC_RANGES['1h'];
  const now = at('2026-09-23T12:00:30Z');

  it('writes every step, oldest first, with counts and derived figures', () => {
    const rows = seriesRows(
      range,
      [
        bucket(at('2026-09-23T11:30:00Z'), {
          requests: 120,
          status2xx: 114,
          status5xx: 6,
          latencySumMs: 1200,
          latencyMaxMs: 40,
          latencyLe10: 120,
        }),
      ],
      now,
      {},
    );
    expect(rows).toHaveLength(60);
    expect(rows[0][0]).toBe('2026-09-23T11:01:00.000Z');
    const hit = rows.find((row) => row[0] === '2026-09-23T11:30:00.000Z')!;
    const cell = (name: (typeof SERIES_HEADER)[number]) => hit[SERIES_HEADER.indexOf(name)];
    expect(cell('requests')).toBe(120);
    expect(cell('status_5xx')).toBe(6);
    expect(cell('req_per_s')).toBe(2);
    expect(cell('error_rate_5xx')).toBe(0.05);
    expect(cell('latency_avg_ms')).toBe(10);
    expect(cell('latency_max_ms')).toBe(40);
    // An empty step is a real zero, with no rates or latencies.
    expect(rows[1].slice(1, 3)).toEqual([0, 0]);
    expect(rows[1][SERIES_HEADER.indexOf('error_rate_5xx')]).toBeNull();
  });

  it('leaves the maximum empty when the source has none (Prometheus)', () => {
    const rows = seriesRows(
      range,
      [bucket(at('2026-09-23T11:30:00Z'), { requests: 1, latencyMaxMs: 10_000 })],
      now,
      { exactMax: false },
    );
    const hit = rows.find((row) => row[1] === 1)!;
    expect(hit[SERIES_HEADER.indexOf('latency_max_ms')]).toBeNull();
  });
});

describe('breakdownRows', () => {
  it('lists the groups, then "Everything else", with shares of the total', () => {
    const start = at('2026-09-23T11:00:00Z');
    const rows = breakdownRows(
      'key',
      [{ value: 'abc123', label: 'Mobile app', bucket: bucket(start, { requests: 30 }) }],
      bucket(start, { requests: 10 }),
      40,
      3600,
      {},
    );
    expect(rows.map((row) => row.slice(0, 5))).toEqual([
      ['key', 'abc123', 'Mobile app', 30, 0.75],
      ['key', '', 'Everything else', 10, 0.25],
    ]);
    expect(rows[0]).toHaveLength(BREAKDOWN_HEADER.length);
  });

  it('drops an empty "Everything else"', () => {
    expect(breakdownRows('api', [], emptyBucket(0), 0, 60, {})).toEqual([]);
  });
});

describe('exportFileName', () => {
  it('is safe on every OS', () => {
    expect(
      exportFileName('series', 'prod/eu "1"', at('2026-09-01T00:00Z'), at('2026-09-02T12:30Z')),
    ).toBe('g2way-traffic-series-prod_eu__1_-20260901T0000Z-20260902T1230Z.csv');
  });
});
