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

6. **Drill-down folds, never multiplies** (_added 2026-09-23, M6 drill-down_).
   A breakdown chart draws request rate per group. When the three busiest
   groups are all the traffic, each gets its own slot. Otherwise the two
   busiest get slots 1 and 2 and slot 3 is "Everything else": the selection's
   total minus those two, so the lines always add up to the total. We chose
   this over small multiples: one chart keeps a shared y-axis and reads as
   parts of a whole, and the table under it lists the ten busiest groups with
   exact figures, plus an "Everything else" row. The folding is
   `breakdownSeries` (`src/lib/analytics/drill.ts`).

   What a drill-down can select follows the rollups (ADR-0012 §5): one API or
   all of them, and at most one value of one other dimension. A breakdown is
   offered only where the rows can answer it: any dimension without a focus,
   only by API under one (the focus's rows grouped by `api_id`), and by code
   inside a status class. Key × path is never offered.

7. **A custom range is an absolute window in the URL, read like a fixed
   one** (_added 2026-09-23, M6 date-range picker_). `?from=` and `?to=`
   (UTC, `YYYY-MM-DDTHH:mm`, the value format of a `datetime-local` input)
   replace `?range=`. The picker is a plain GET form under the range buttons,
   with the rest of the selection in hidden fields, so it needs no client
   code. `customRange` (`src/lib/analytics/custom-range.ts`) turns the window
   into a `TrafficRange` with an `end`, and everything downstream
   (`trafficWindow`, `trafficSeries`, the breakdowns, both readers) is
   unchanged.
   - Step: the shortest of 1, 2, 5, 10, 15 and 30 minutes, 1, 3, 6 and 12
     hours, and 1 day that keeps the chart at 400 points or fewer. The window
     is widened to whole steps. Longer than 400 days is refused.
   - Rows: minute rows for sub-hour steps, hour rows from one hour up. A
     window that starts before minute retention
     (`G2_ANALYTICS_MINUTE_RETENTION_DAYS`) can only read hour rows, so its
     step is an hour or more, and the page says so. A window starting before
     hour retention says that the older part has been pruned.
   - Prometheus: steps of at least 2 minutes, so each has two scrapes at
     Prometheus's default one-minute `scrape_interval`. 400 points is far
     under its 11 000 per series. Retention there is Prometheus's own, and
     unknown to us.
   - Refused, with the reason on the page and the fixed range shown instead:
     only one of `from`/`to`, one that does not parse, an end not after the
     start, a start in the future, or under 5 minutes. An end in the future
     becomes now, with a note, and its last step is still filling. A window
     wholly in the past has no filling step (`Traffic.filling`), so the
     "still filling" caveat is not shown.

8. **CSV export is the view on screen, one file per table** (_added
   2026-09-23, M6 CSV export_). `GET /api/analytics/export?table=series|breakdown`
   takes the page's own URL parameters and reads through the same
   `resolveView` (`src/lib/analytics/view.ts`), so a download matches the
   page, including a custom window and the source. It sits behind `withUser`
   and `gateway:read`, like the page. Key focus and the key breakdown still
   need `keys:read` (`parseDrill`), so a role without it gets no key column.
   - Files: `series` has one row per step, empty steps included, with status
     counts and the derived rates and latencies. `breakdown` lists up to
     1 000 groups plus "Everything else", not only the ten the page shows.
     Each file opens with `# name,value` rows naming the environment, source,
     window, step, selection and every note the page would show, then a
     header row. `#` is the usual comment marker for CSV readers. We chose
     two files over one file with sections, which no CSV reader handles.
   - Every text cell starting with `=`, `+`, `-`, `@`, a tab or a CR gets a
     leading `'`, so a spreadsheet shows it as text rather than running it.
     API ids, paths and key aliases come from traffic, and anyone can put
     them there. Numbers are written as they are.
   - Under Prometheus the file says its counts are rounded `increase()`
     values summed over replicas, and `latency_max_ms` is empty.
   - Never from the live inspector's tail: `analytics_tail` is a sample
     (ADR-0014), and an export built on it would look complete when it
     is not.
   - An export is a read, so it is not audited (ADR-0006 audits mutations).

## Consequences

- No new dependency. Chart code is ours to maintain, and the pure helpers
  are tested like the rest of `src/lib`.
- Later M6 charts (drill-down by dimension, saved views) reuse
  `TimeSeriesChart`, `trafficSeries` and `queryTrafficBuckets`. Only the
  query's filter and the series change.
- A custom date range chooses a granularity and a step the way
  `TRAFFIC_RANGES` does (§7). The hour rows are the only option past minute
  retention. The fixed ranges do not yet check retention (M6 box).
