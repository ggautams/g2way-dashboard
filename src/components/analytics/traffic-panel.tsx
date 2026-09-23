import Link from 'next/link';
import { formatTimestamp, formatValue, type ChartUnit } from '@/lib/analytics/chart';
import { TRAFFIC_RANGES, TRAFFIC_RANGE_IDS, type Traffic } from '@/lib/analytics/traffic';
import { TimeSeriesChart } from './time-series-chart';

/**
 * The traffic section of `/analytics`: a range picker, headline tiles, the
 * RPS, error-rate and latency charts, and a table view of every point. A
 * Server Component; only `TimeSeriesChart` runs in the browser, and it gets
 * plain numbers.
 */
export function TrafficPanel({ traffic }: { traffic: Traffic }) {
  const { range, points, summary, from, to } = traffic;
  const starts = points.map((p) => p.start);
  const stepMs = range.stepSeconds * 1000;
  const chart = { starts, stepMs, from, to };
  const hasTraffic = summary.requests > 0;
  const step = formatStep(range.stepSeconds);

  return (
    <section aria-labelledby="traffic-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="traffic-heading" className="text-lg font-semibold">
          Traffic
        </h2>
        <RangePicker current={range.id} />
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Tile label="Requests" value={summary.requests.toLocaleString('en')} />
        <Tile label="Avg req/s" value={formatValue(summary.rps, 'rps')} />
        <Tile label="Error rate (5xx)" value={formatValue(summary.serverErrorRate, 'percent')} />
        <Tile label="4xx rate" value={formatValue(summary.clientErrorRate, 'percent')} />
        <Tile label="Latency p50" value={formatValue(summary.p50, 'ms')} />
        <Tile label="Latency p95" value={formatValue(summary.p95, 'ms')} />
        <Tile label="Latency p99" value={formatValue(summary.p99, 'ms')} />
      </dl>

      {hasTraffic ? (
        <>
          <TimeSeriesChart
            title={`Requests per second (per ${step})`}
            description={`Average requests per second in each ${step}, ${range.label.toLowerCase()}; ${formatValue(summary.rps, 'rps')} on average.`}
            unit="rps"
            {...chart}
            series={[{ label: 'req/s', slot: 1, values: points.map((p) => p.rps) }]}
          />
          <TimeSeriesChart
            title="Error rate"
            description={`Share of requests answered 5xx and 4xx in each ${step}; ${formatValue(summary.serverErrorRate, 'percent')} and ${formatValue(summary.clientErrorRate, 'percent')} over the range.`}
            unit="percent"
            {...chart}
            series={[
              { label: '5xx', slot: 1, values: points.map((p) => p.serverErrorRate) },
              { label: '4xx', slot: 2, values: points.map((p) => p.clientErrorRate) },
            ]}
          />
          <TimeSeriesChart
            title="Latency (estimated)"
            description={`Estimated p50, p95 and p99 gateway latency in each ${step}; ${formatValue(summary.p50, 'ms')}, ${formatValue(summary.p95, 'ms')} and ${formatValue(summary.p99, 'ms')} over the range.`}
            unit="ms"
            {...chart}
            series={[
              { label: 'p50', slot: 1, values: points.map((p) => p.p50) },
              { label: 'p95', slot: 2, values: points.map((p) => p.p95) },
              { label: 'p99', slot: 3, values: points.map((p) => p.p99) },
            ]}
          />
          <p className="text-xs text-muted">
            Times are UTC; the last {step} is still filling, so its rate covers the time elapsed so
            far. Percentiles are estimated from a latency histogram (buckets up to 10 s), not exact:
            the dashboard keeps rollups, never raw requests. Latency is the gateway&apos;s total per
            request; max {formatValue(summary.latencyMaxMs, 'ms')}, mean{' '}
            {formatValue(summary.latencyAvgMs, 'ms')}.
          </p>
          <TrafficTable traffic={traffic} />
        </>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted">
          No requests recorded in the {range.label.toLowerCase()}. The ingest panel above says
          whether records are arriving.
        </p>
      )}
    </section>
  );
}

function RangePicker({ current }: { current: string }) {
  return (
    <nav aria-label="Time range">
      <ul className="flex flex-wrap gap-1 rounded-md border border-border bg-surface p-0.5 text-sm">
        {TRAFFIC_RANGE_IDS.map((id) => {
          const selected = id === current;
          return (
            <li key={id}>
              <Link
                href={`/analytics?range=${id}`}
                aria-current={selected ? 'page' : undefined}
                title={TRAFFIC_RANGES[id].label}
                className={
                  selected
                    ? 'block rounded px-2.5 py-1 font-medium bg-subtle text-foreground'
                    : 'block rounded px-2.5 py-1 text-muted hover:bg-subtle/60 hover:text-foreground'
                }
              >
                {id}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
    </div>
  );
}

const COLUMNS: {
  label: string;
  unit: ChartUnit;
  value: (p: Traffic['points'][number]) => number | null;
}[] = [
  { label: 'req/s', unit: 'rps', value: (p) => p.rps },
  { label: '5xx', unit: 'percent', value: (p) => p.serverErrorRate },
  { label: '4xx', unit: 'percent', value: (p) => p.clientErrorRate },
  { label: 'p50', unit: 'ms', value: (p) => p.p50 },
  { label: 'p95', unit: 'ms', value: (p) => p.p95 },
  { label: 'p99', unit: 'ms', value: (p) => p.p99 },
];

/** Every chart point as a table: the charts' accessible and exact form. Newest first. */
function TrafficTable({ traffic }: { traffic: Traffic }) {
  const rows = traffic.points.filter((p) => p.requests > 0).reverse();
  return (
    <details className="rounded-lg border border-border bg-surface">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium">
        Show as table ({rows.length} {rows.length === 1 ? 'step' : 'steps'} with traffic)
      </summary>
      <div className="max-h-96 overflow-auto border-t border-border">
        <table className="w-full text-sm tabular-nums">
          <caption className="sr-only">
            {`Traffic per ${formatStep(traffic.range.stepSeconds)}, ${traffic.range.label.toLowerCase()}, newest first; steps without requests are omitted.`}
          </caption>
          <thead className="sticky top-0 bg-surface text-xs text-muted">
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Step start
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Requests
              </th>
              {COLUMNS.map((c) => (
                <th key={c.label} scope="col" className="px-3 py-2 text-right font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.start} className="border-b border-border last:border-0">
                <th scope="row" className="px-3 py-1.5 text-left font-normal whitespace-nowrap">
                  <time dateTime={new Date(p.start).toISOString()}>{formatTimestamp(p.start)}</time>
                </th>
                <td className="px-3 py-1.5 text-right">{p.requests.toLocaleString('en')}</td>
                {COLUMNS.map((c) => (
                  <td key={c.label} className="px-3 py-1.5 text-right">
                    {formatValue(c.value(p), c.unit)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function formatStep(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hour' : `${seconds / 3600} hours`;
  return seconds === 60 ? 'minute' : `${seconds / 60} minutes`;
}
