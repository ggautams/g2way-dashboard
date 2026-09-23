'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  formatTick,
  formatTickValue,
  formatTimestamp,
  formatValue,
  niceTicks,
  timeTicks,
  type ChartUnit,
} from '@/lib/analytics/chart';

/**
 * A line chart over time, drawn as inline SVG (ADR-0013). Receives plain
 * numbers only. Colors are the `--series-N` tokens, stepped per theme in
 * `globals.css`; text wears text tokens, never a series color. A crosshair and
 * tooltip follow the pointer, and the same readout follows the arrow keys when
 * the plot has focus. The page's table view carries every value without it.
 */

export type ChartSeries = {
  label: string;
  /** Categorical slot, 1–3, in fixed order (ADR-0013). */
  slot: 1 | 2 | 3;
  /** One value per point; `null` where the step had no requests. */
  values: (number | null)[];
};

const HEIGHT = 200;
const MARGIN = { top: 12, right: 16, bottom: 24, left: 60 };

export function TimeSeriesChart({
  title,
  description,
  unit,
  starts,
  stepMs,
  from,
  to,
  series,
}: {
  title: string;
  /** One sentence summarising the chart, for its accessible description. */
  description: string;
  unit: ChartUnit;
  /** Each point's step start (Unix ms). */
  starts: number[];
  stepMs: number;
  from: number;
  to: number;
  series: ChartSeries[];
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const peak = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const y = niceTicks(peak);
  const yStep = y.ticks[1] ?? y.max;
  // A point sits at the middle of its step.
  const xOf = (t: number) => MARGIN.left + ((t - from) / (to - from)) * plotW;
  const xAt = (i: number) => xOf(starts[i] + stepMs / 2);
  const yOf = (v: number) => MARGIN.top + plotH - (v / y.max) * plotH;
  const single = series.length === 1;

  const indexAt = (clientX: number, rect: DOMRect) => {
    const t = from + ((clientX - rect.left - MARGIN.left) / plotW) * (to - from);
    return Math.min(starts.length - 1, Math.max(0, Math.floor((t - from) / stepMs)));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = starts.length - 1;
    const moves: Record<string, (i: number) => number> = {
      ArrowLeft: (i) => Math.max(0, i - 1),
      ArrowRight: (i) => Math.min(last, i + 1),
      Home: () => 0,
      End: () => last,
    };
    if (event.key === 'Escape') return setActive(null);
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setActive((i) => move(i ?? last));
  };

  const tooltipLeft = active === null ? 0 : xAt(active);
  const flip = tooltipLeft > width / 2;

  return (
    <figure className="flex min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-surface p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span id={`${id}-title`} className="text-sm font-medium">
          {title}
        </span>
        {!single && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
            {series.map((s) => (
              <li key={s.label} className="flex items-center gap-1.5">
                <svg width="14" height="4" aria-hidden="true">
                  <line
                    x1="1"
                    x2="13"
                    y1="2"
                    y2="2"
                    stroke={`var(--series-${s.slot})`}
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </figcaption>
      <div
        ref={box}
        className="relative w-full outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded"
        tabIndex={0}
        role="group"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
        onPointerMove={(event) =>
          setActive(indexAt(event.clientX, event.currentTarget.getBoundingClientRect()))
        }
        onPointerLeave={() => setActive(null)}
      >
        <p id={`${id}-desc`} className="sr-only">
          {description} Use the left and right arrow keys to read values; the table below lists
          every point.
        </p>
        <svg width={width} height={HEIGHT} aria-hidden="true" className="block">
          {y.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={yOf(tick)}
                y2={yOf(tick)}
                stroke="var(--border)"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              <text
                x={MARGIN.left - 8}
                y={yOf(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted text-[11px] tabular-nums"
              >
                {formatTickValue(tick, yStep, unit)}
              </text>
            </g>
          ))}
          {timeTicks(from, to, Math.max(2, Math.floor(plotW / 110))).map((tick) => (
            <text
              key={tick}
              x={xOf(tick)}
              y={HEIGHT - 6}
              textAnchor="middle"
              className="fill-muted text-[11px] tabular-nums"
            >
              {formatTick(tick, to - from)}
            </text>
          ))}
          {series.map((s) => (
            <g key={s.label}>
              {single && (
                <path
                  d={areaPath(s.values, xAt, yOf, yOf(0))}
                  fill={`var(--series-${s.slot})`}
                  opacity={0.1}
                />
              )}
              <path
                d={linePath(s.values, xAt, yOf)}
                fill="none"
                stroke={`var(--series-${s.slot})`}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {isolated(s.values).map((i) => (
                <circle
                  key={i}
                  cx={xAt(i)}
                  cy={yOf(s.values[i] as number)}
                  r="4"
                  fill={`var(--series-${s.slot})`}
                />
              ))}
            </g>
          ))}
          {active !== null && (
            <g>
              <line
                x1={xAt(active)}
                x2={xAt(active)}
                y1={MARGIN.top}
                y2={MARGIN.top + plotH}
                stroke="var(--muted)"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              {series.map((s) => {
                const v = s.values[active];
                return v === null ? null : (
                  <circle
                    key={s.label}
                    cx={xAt(active)}
                    cy={yOf(v)}
                    r="4"
                    fill={`var(--series-${s.slot})`}
                    stroke="var(--surface)"
                    strokeWidth="2"
                  />
                );
              })}
            </g>
          )}
        </svg>
        <div
          aria-live="polite"
          className={
            active === null
              ? 'sr-only'
              : 'pointer-events-none absolute top-2 z-10 min-w-36 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-md'
          }
          style={
            active === null
              ? undefined
              : flip
                ? { right: width - tooltipLeft + 12 }
                : { left: tooltipLeft + 12 }
          }
        >
          {active !== null && (
            <>
              <p className="mb-1 text-muted">{formatTimestamp(starts[active])}</p>
              <ul className="flex flex-col gap-0.5">
                {series.map((s) => (
                  <li key={s.label} className="flex items-center gap-2">
                    <svg width="10" height="4" aria-hidden="true">
                      <line
                        x1="1"
                        x2="9"
                        y1="2"
                        y2="2"
                        stroke={`var(--series-${s.slot})`}
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                    <span className="font-semibold tabular-nums">
                      {formatValue(s.values[active], unit)}
                    </span>
                    <span className="text-muted">{s.label}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </figure>
  );
}

/** An SVG path through the points, broken where a value is missing. */
function linePath(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Points with no neighbour to draw a line to: they get a dot instead. */
function isolated(values: (number | null)[]): number[] {
  return values.flatMap((v, i) =>
    v !== null && (values[i - 1] ?? null) === null && (values[i + 1] ?? null) === null ? [i] : [],
  );
}

/** The area under each unbroken run of points, down to `base`. */
function areaPath(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
  base: number,
): string {
  let d = '';
  let run: number[] = [];
  const close = () => {
    if (run.length > 0) {
      d += `M${x(run[0]).toFixed(1)},${base}`;
      for (const i of run) d += `L${x(i).toFixed(1)},${y(values[i] as number).toFixed(1)}`;
      d += `L${x(run.at(-1)!).toFixed(1)},${base}Z`;
    }
    run = [];
  };
  values.forEach((v, i) => (v === null ? close() : run.push(i)));
  close();
  return d;
}
