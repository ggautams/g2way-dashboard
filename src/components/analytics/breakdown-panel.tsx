import Link from 'next/link';
import { formatValue } from '@/lib/analytics/chart';
import {
  DIMENSION_LABELS,
  PATH_TEMPLATE_NOTE,
  type BreakdownDimension,
  type BreakdownSeries,
  type GroupDisplay,
} from '@/lib/analytics/drill';
import type { TrafficSummary } from '@/lib/analytics/traffic';
import { TimeSeriesChart } from './time-series-chart';

/** One row of the breakdown table, as the page prepared it. */
export type BreakdownItem = GroupDisplay & {
  id: string;
  requests: number;
  /** Of the selection's requests, 0–1. */
  share: number;
  summary: TrafficSummary;
  /** Narrows the page to this group; `null` for "Everything else". */
  drillHref: string | null;
  /** The API's or key's own page, where one exists and the role may read it. */
  page: { href: string; label: string } | null;
};

export type BreakdownView = {
  by: BreakdownDimension;
  /** Every breakdown this selection can answer, with its href. */
  tabs: { dimension: BreakdownDimension; href: string }[];
  /** A heading for the groups: "Status class", "Status code", "API", … */
  groupHeading: string;
  items: BreakdownItem[];
  chart: {
    starts: number[];
    stepMs: number;
    from: number;
    to: number;
    series: BreakdownSeries[];
  } | null;
  /** The range after a comma (`last hour`), and after "nothing" (`in the last hour`); see `rangePhrase`. */
  rangePhrase: string;
  rangeWithin: string;
  step: string;
};

/**
 * The breakdown of the selected traffic by one dimension (ADR-0012 §5): a
 * request-rate chart of the busiest groups (at most three lines, ADR-0013 §2)
 * and a table of the busiest groups, each a link that narrows the page to
 * it. A Server Component; the chart gets plain numbers.
 */
export function BreakdownPanel({ view }: { view: BreakdownView }) {
  const { by, tabs, items, chart } = view;
  const label = DIMENSION_LABELS[by];
  return (
    <section aria-labelledby="breakdown-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="breakdown-heading" className="text-lg font-semibold">
          Breakdown by {view.groupHeading.toLowerCase()}
        </h2>
        {tabs.length > 1 && (
          <nav aria-label="Break down by">
            <ul className="flex flex-wrap gap-1 rounded-md border border-border bg-surface p-0.5 text-sm">
              {tabs.map((tab) => {
                const selected = tab.dimension === by;
                return (
                  <li key={tab.dimension}>
                    <Link
                      href={tab.href}
                      aria-current={selected ? 'page' : undefined}
                      className={
                        selected
                          ? 'block rounded px-2.5 py-1 font-medium bg-subtle text-foreground'
                          : 'block rounded px-2.5 py-1 text-muted hover:bg-subtle/60 hover:text-foreground'
                      }
                    >
                      {DIMENSION_LABELS[tab.dimension]}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>
      {by === 'path' && <p className="-mt-2 text-xs text-muted">{PATH_TEMPLATE_NOTE}</p>}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted">
          Nothing to break down {view.rangeWithin}.
        </p>
      ) : (
        <>
          {chart !== null && chart.series.length > 0 && (
            <TimeSeriesChart
              title={`Requests per second by ${label.toLowerCase()} (per ${view.step})`}
              description={`Average requests per second in each ${view.step} for ${chart.series
                .map((s) => s.label)
                .join(', ')}; ${view.rangePhrase}.`}
              unit="rps"
              starts={chart.starts}
              stepMs={chart.stepMs}
              from={chart.from}
              to={chart.to}
              series={chart.series}
            />
          )}
          <BreakdownTable view={view} />
        </>
      )}
    </section>
  );
}

function BreakdownTable({ view }: { view: BreakdownView }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">
          {`The busiest values by ${view.groupHeading.toLowerCase()}, ${view.rangePhrase}, most requests first. Percentiles are estimated.`}
        </caption>
        <thead className="text-xs text-muted">
          <tr className="border-b border-border">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {view.groupHeading}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Requests
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Share
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              req/s
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              5xx
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              4xx
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              p50
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              p95
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              p99
            </th>
          </tr>
        </thead>
        <tbody>
          {view.items.map((item) => (
            <tr key={item.id} className="border-b border-border last:border-0">
              <th scope="row" className="max-w-md px-3 py-1.5 text-left font-normal">
                <GroupCell item={item} />
              </th>
              <td className="px-3 py-1.5 text-right">{item.requests.toLocaleString('en')}</td>
              <td className="px-3 py-1.5 text-right">{formatValue(item.share, 'percent')}</td>
              <td className="px-3 py-1.5 text-right">{formatValue(item.summary.rps, 'rps')}</td>
              <td className="px-3 py-1.5 text-right">
                {formatValue(item.summary.serverErrorRate, 'percent')}
              </td>
              <td className="px-3 py-1.5 text-right">
                {formatValue(item.summary.clientErrorRate, 'percent')}
              </td>
              <td className="px-3 py-1.5 text-right">{formatValue(item.summary.p50, 'ms')}</td>
              <td className="px-3 py-1.5 text-right">{formatValue(item.summary.p95, 'ms')}</td>
              <td className="px-3 py-1.5 text-right">{formatValue(item.summary.p99, 'ms')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupCell({ item }: { item: BreakdownItem }) {
  const text = item.mono ? 'font-mono text-xs break-all' : '';
  return (
    <div className="flex flex-col">
      <span className="flex flex-wrap items-baseline gap-x-2">
        {item.drillHref === null ? (
          <span className={`text-muted ${text}`}>{item.label}</span>
        ) : (
          <Link
            href={item.drillHref}
            className={`font-medium hover:underline ${text}`}
            title={`Narrow the page to ${item.label}`}
          >
            {item.label}
          </Link>
        )}
        {item.page !== null && (
          <Link href={item.page.href} className="text-xs text-muted hover:underline">
            {item.page.label}
          </Link>
        )}
      </span>
      {item.detail !== null && <span className="font-mono text-xs text-muted">{item.detail}</span>}
    </div>
  );
}
