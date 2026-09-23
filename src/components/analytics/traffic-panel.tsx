import Link from 'next/link';
import { formatTimestamp, formatValue, type ChartUnit } from '@/lib/analytics/chart';
import {
  TRAFFIC_RANGES,
  TRAFFIC_RANGE_IDS,
  rangePhrase,
  rangeWithin,
  type Traffic,
  type TrafficRangeId,
  type TrafficSource,
} from '@/lib/analytics/traffic';
import { TimeSeriesChart } from './time-series-chart';

/**
 * The traffic section of `/analytics`: a range picker, headline tiles, the
 * RPS, error-rate and latency charts, and a table view of every point. A
 * Server Component; only `TimeSeriesChart` runs in the browser, and it gets
 * plain numbers. `rangeHrefs` keeps the drill-down when the range changes,
 * and lists only the ranges the source offers; `scoped` says the traffic is
 * narrowed by one. `sources` is the Rollups | Prometheus toggle, present only
 * where the environment has a Prometheus (ADR-0015 §2). `custom` is the
 * custom-range form (ADR-0013 §7): a plain GET form, no client code.
 */
export function TrafficPanel({
  traffic,
  rangeHrefs,
  scoped = false,
  source = 'rollups',
  sourceHrefs = null,
  warnings = [],
  custom,
}: {
  traffic: Traffic;
  rangeHrefs: Partial<Record<TrafficRangeId, string>>;
  scoped?: boolean;
  source?: TrafficSource;
  sourceHrefs?: Record<TrafficSource, string> | null;
  /** Prometheus's own query warnings, shown as it gave them. */
  warnings?: readonly string[];
  custom: CustomRangeForm;
}) {
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
        <div className="flex flex-wrap items-center gap-2">
          {sourceHrefs !== null && <SourcePicker current={source} hrefs={sourceHrefs} />}
          <RangePicker current={range.id} hrefs={rangeHrefs} />
        </div>
      </div>
      <CustomRange form={custom} active={range.id === 'custom'} />

      {warnings.length > 0 && (
        <ul
          aria-label="Prometheus warnings"
          className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"
        >
          {warnings.map((warning) => (
            <li key={warning} className="font-mono text-xs">
              Prometheus warning: {warning}
            </li>
          ))}
        </ul>
      )}

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
            description={`Average requests per second in each ${step}, ${rangePhrase(range)}; ${formatValue(summary.rps, 'rps')} on average.`}
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
          {source === 'prometheus' ? (
            <p className="text-xs text-muted">
              Times are UTC{traffic.filling ? `; the last ${step} is still filling` : ''}. From
              Prometheus: counts are the rounded <code className="font-mono">increase()</code> of
              g2way&apos;s request-duration histogram, summed over replicas, and reach back only as
              far as Prometheus keeps data. Percentiles are estimated from that histogram&apos;s
              buckets (5 ms to 10 s, so nothing finer than 5 ms). Latency is the gateway&apos;s
              total per request; mean {formatValue(summary.latencyAvgMs, 'ms')}. The metric keeps no
              maximum.
            </p>
          ) : (
            <p className="text-xs text-muted">
              Times are UTC
              {traffic.filling
                ? `; the last ${step} is still filling, so its rate covers the time elapsed so far`
                : ''}
              . Percentiles are estimated from a latency histogram (buckets up to 10 s), not exact:
              the dashboard keeps rollups, never raw requests. Latency is the gateway&apos;s total
              per request; max {formatValue(summary.latencyMaxMs, 'ms')}, mean{' '}
              {formatValue(summary.latencyAvgMs, 'ms')}.
            </p>
          )}
          <TrafficTable traffic={traffic} />
        </>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted">
          No requests recorded {rangeWithin(range)}
          {scoped ? ' for this selection' : ''}.{' '}
          {source === 'prometheus'
            ? 'Prometheus returned no samples: check that it scrapes the gateway’s /metrics, that G2_PROMETHEUS_SELECTOR matches, and that its retention covers the range.'
            : 'The ingest panel above says whether records are arriving.'}
        </p>
      )}
    </section>
  );
}

function RangePicker({
  current,
  hrefs,
}: {
  current: string;
  hrefs: Partial<Record<TrafficRangeId, string>>;
}) {
  return (
    <Segmented
      label="Time range"
      items={TRAFFIC_RANGE_IDS.flatMap((id) => {
        const href = hrefs[id];
        return href === undefined
          ? []
          : [{ id, text: id, title: TRAFFIC_RANGES[id].label, href, selected: id === current }];
      })}
    />
  );
}

/**
 * The custom-range form's inputs: the dates to show (the custom window, else
 * the current fixed window, as `YYYY-MM-DDTHH:mm` UTC), the rest of the
 * selection as hidden fields, and whether to show it open (a custom range is
 * active, or the last one was refused).
 */
export type CustomRangeForm = {
  from: string;
  to: string;
  hidden: readonly (readonly [string, string])[];
  problem: string | null;
};

function CustomRange({ form, active }: { form: CustomRangeForm; active: boolean }) {
  return (
    <details
      open={active || form.problem !== null}
      className="rounded-lg border border-border bg-surface text-sm"
    >
      <summary className="cursor-pointer px-4 py-2 font-medium">
        Custom range{active ? ' (showing)' : ''}
      </summary>
      <form
        method="get"
        action="/analytics"
        className="flex flex-wrap items-end gap-3 border-t border-border px-4 py-3"
      >
        {form.hidden.map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">From (UTC)</span>
          <input
            type="datetime-local"
            name="from"
            required
            step={60}
            defaultValue={form.from}
            aria-invalid={form.problem !== null || undefined}
            className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">To (UTC)</span>
          <input
            type="datetime-local"
            name="to"
            required
            step={60}
            defaultValue={form.to}
            aria-invalid={form.problem !== null || undefined}
            className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
          />
        </label>
        <button
          type="submit"
          className="rounded-md border border-border bg-subtle px-3 py-1 font-medium hover:bg-subtle/60"
        >
          Show
        </button>
        {form.problem !== null && (
          <p role="alert" className="w-full text-xs text-danger">
            {form.problem}
          </p>
        )}
        <p className="w-full text-xs text-muted">
          Both times are UTC, whatever your browser&apos;s time zone. The step is picked to keep the
          chart at 400 points or fewer; the rollups read hour rows once a range starts before minute
          retention.
        </p>
      </form>
    </details>
  );
}

const SOURCE_LABELS: Record<TrafficSource, { text: string; title: string }> = {
  rollups: { text: 'Rollups', title: 'The dashboard’s own rollups of the gateway’s analytics' },
  prometheus: { text: 'Prometheus', title: 'The gateway’s request-duration metric in Prometheus' },
};

function SourcePicker({
  current,
  hrefs,
}: {
  current: TrafficSource;
  hrefs: Record<TrafficSource, string>;
}) {
  return (
    <Segmented
      label="Data source"
      items={(Object.keys(hrefs) as TrafficSource[]).map((id) => ({
        id,
        ...SOURCE_LABELS[id],
        href: hrefs[id],
        selected: id === current,
      }))}
    />
  );
}

function Segmented({
  label,
  items,
}: {
  label: string;
  items: { id: string; text: string; title: string; href: string; selected: boolean }[];
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-1 rounded-md border border-border bg-surface p-0.5 text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              aria-current={item.selected ? 'page' : undefined}
              title={item.title}
              className={
                item.selected
                  ? 'block rounded px-2.5 py-1 font-medium bg-subtle text-foreground'
                  : 'block rounded px-2.5 py-1 text-muted hover:bg-subtle/60 hover:text-foreground'
              }
            >
              {item.text}
            </Link>
          </li>
        ))}
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
            {`Traffic per ${formatStep(traffic.range.stepSeconds)}, ${rangePhrase(traffic.range)}, newest first; steps without requests are omitted.`}
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

export function formatStep(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'day' : `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hour' : `${seconds / 3600} hours`;
  return seconds === 60 ? 'minute' : `${seconds / 60} minutes`;
}
