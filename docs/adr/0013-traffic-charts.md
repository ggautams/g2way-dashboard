# ADR-0013: Traffic charts: hand-rolled SVG, a fixed series palette, estimated percentiles

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0001 §5, ADR-0012 §5

## Context

M6's first charts (RPS, error rate, latency p50/p95/p99 on `/analytics`) need
a way to draw a time series. ADR-0001 chose Tailwind and shadcn/ui and says
nothing about charts. `package.json` has no chart library. The rest of M6
(drill-down, the live inspector, saved views) will draw more of the same
kind of chart, so this choice sets the pattern.

The rollups (ADR-0012 §5) keep a latency histogram with fixed bounds, not raw
latencies, so any percentile the dashboard shows is an estimate.

## Decisions

1. **Charts are inline SVG we draw ourselves, not a library.** A line chart
   over a few hundred points needs scales, ticks, a path and a hover layer,
   about 300 lines. Recharts or visx would add a sizeable client bundle and a
   theming layer to fight. Chart.js draws on a canvas, which is harder to theme
   with CSS variables and harder to make accessible. The pure parts
   (`niceTicks`, `timeTicks`, value formatting) live in
   `src/lib/analytics/chart.ts` and are unit-tested. The one client component,
   `TimeSeriesChart` (`src/components/analytics/time-series-chart.tsx`), gets
   plain numbers from a Server Component, so nothing server-side can reach
   the browser through it. If a later chart needs something this cannot do
   well (brushing, thousands of points, maps), adopting a library then needs
   a new ADR.

2. **Series colors are three fixed tokens, `--series-1..3`**, in
   `globals.css`, stepped separately for light and dark:
   blue `#2a78d6` / `#3987e5`, orange `#eb6834` / `#d95926`, aqua
   `#1baf7a` / `#199e70`. They were checked with a colour-vision-deficiency
   validator against our `--surface` in each theme: every pair passes, and the
   worst is ΔE 9.2 in light and 9.4 in dark. Slots are assigned in fixed order
   and never cycled. A chart with more than three series folds the rest into
   "other" or splits into small multiples. It never generates a fourth hue.
   Light-mode aqua is below 3:1 against white, so every chart also has a
   legend (for two or more series) and a table view. Status colors
   (`--danger`, `--warning`, `--success`) are not series colors.

3. **Every chart is accessible without its hover layer.** Each chart is a
   `figure` with a title, a legend for two or more series, and a description
   that states the headline values. The plot has keyboard focus, and the arrow
   keys move the same readout the pointer shows, announced through a live
   region. The page puts every point in a `<details>` table. Axis and label
   text uses text tokens, never a series color. Times are UTC, as elsewhere
   in the dashboard, which also keeps the server and client renders
   identical.

4. **Percentiles are estimated by linear interpolation in the histogram.**
   Find the bucket that holds the q·n-th request and interpolate between its
   lower bound (the previous bound, or 0) and its upper bound. The exact
   `latency_max_ms` caps the upper bound, and it is the only bound on the
   open `latency_over` bucket (above 10 s). The error is at most one bucket's
   width, and the UI labels the latency chart "estimated". Averages come from
   `latency_sum_ms / requests` and are exact.

5. **Fixed ranges read one granularity and re-bucket to a step.** `1h`, `6h`
   and `24h` read minute rows, at steps of 1, 5 and 15 minutes. `7d` and `30d`
   read hour rows, at steps of 1 and 6 hours. Steps are epoch-aligned. The
   last step contains now, and its rate divides by the time elapsed in it, not
   the whole step. Steps without traffic are gap-filled: 0 req/s, and no
   error-rate or latency point (the line breaks there). The ranges live in
   `TRAFFIC_RANGES` (`src/lib/analytics/traffic.ts`). The `24h` range needs at
   least a day of minute retention (`G2_ANALYTICS_MINUTE_RETENTION_DAYS`,
   default 3).

## Consequences

- No new dependency. Chart code is ours to maintain, and the pure helpers
  are tested like the rest of `src/lib`.
- Later M6 charts (drill-down by dimension, saved views) reuse
  `TimeSeriesChart`, `trafficSeries` and `queryTrafficBuckets`. Only the
  query's filter and the series change.
- A custom date range (M6's picker task) has to choose a granularity and a
  step the way `TRAFFIC_RANGES` does. The hour rows are the only option past
  minute retention.
