# ADR-0015: An optional Prometheus datasource for long-range traffic

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0007, ADR-0012, ADR-0013

## Context

The traffic charts on `/analytics` read the dashboard's own rollups
(ADR-0012 §5, ADR-0013). Hour rows are kept 90 days by default and minute rows
3 days, and the rollups exist only from the day the ingest worker started. Many
operators already run Prometheus, often with a long-term store behind it
(Thanos, Mimir, VictoriaMetrics), and it has scraped the gateway for longer
than the dashboard has existed. M6 asks for an optional Prometheus datasource
for long-range aggregates.

What g2way exports decides what the datasource can offer. It serves
`GET /metrics` on the admin listener, unauthenticated
(`contracts/openapi.json`, `contracts/g2way-docs/observability.md`). There is
exactly one request-level instrument, created in
`crates/g2-middleware/src/metrics.rs` and exported through
`opentelemetry_prometheus` in `crates/g2-telemetry/src/metrics.rs`:

- The OTel histogram `http.server.request.duration`, in seconds, exposed as
  `http_server_request_duration_seconds_bucket`, `_count` and `_sum`. It
  measures the whole request, gateway overhead included, which is what the
  rollups' latency measures too.
- Its labels are `http_route` (the API's **listen path**, not the request
  path), `g2_api_id`, `g2_org_id` and `http_response_status_code`, plus `le` on
  the buckets. The exporter adds its `otel_scope_*` labels, and the scrape adds
  `job` and `instance`.
- Its bucket bounds are 5, 10, 25, 50, 75, 100, 250, 500 and 750 ms, then 1,
  2.5, 5, 7.5 and 10 s, and `+Inf`.
- It records only routed requests (no health checks, no 404s). Each replica
  keeps its own cumulative counters, which reset when the process restarts.

It has no method, key or request-path label.

## Decisions

1. **Off by default, configured per environment, and held like a secret.**
   `G2_PROMETHEUS_URL` (or `G2_ENV_<ID>_PROMETHEUS_URL`) is the base URL of
   anything that serves the Prometheus HTTP API: Prometheus itself or a
   long-term store's Prometheus-compatible prefix. The dashboard adds
   `/api/v1/query_range` to it. Credentials go either in the URL's userinfo
   (sent as HTTP Basic auth, because `fetch` refuses URLs that carry
   credentials) or in `G2_PROMETHEUS_TOKEN` (sent as a bearer token). Both at
   once is a config error, since a request has only one `Authorization`
   header.
   `G2_PROMETHEUS_SELECTOR` adds label matchers, such as `job="g2way-prod"`,
   so one Prometheus that scrapes several gateways can serve each environment.
   The URL and the token live on `GatewayTarget` in private fields, like the
   Redis URL (ADR-0012). They are never serialised or sent to the browser,
   and config problems name the variable, never its value. `check:bundle`
   builds with canaries in both, renders the Prometheus view against a
   Prometheus that refuses connections, and fails if a canary appears.

2. **The user picks the source. The dashboard never switches silently.**
   `/analytics` gets a **Rollups | Prometheus** toggle (`?source=prometheus`),
   shown only when the environment has a Prometheus URL. Rollups stay the
   default. Two ranges, `90d` and `1y` (both with one-day steps), are offered
   only with Prometheus, because they are what the datasource is for. The five
   existing ranges are offered with both sources. A `?range=` the source does
   not offer, or `?source=prometheus` on an environment without one, falls
   back with a note on the page, as ignored drill-down parameters already do.

   Rejected: switching to Prometheus automatically for ranges past rollup
   retention. The two sources differ in what they can break down (§4), their
   sub-5 ms resolution (§3) and whether counts are exact. A chart that
   silently changed source at a range boundary would change what its numbers
   mean without saying so. Retention-aware ranges on the rollup side are a
   separate M6 task.

   _Amended 2026-09-23 (M6, ranges tied to retention):_ the rollups offer
   `90d` and `1y` too wherever this server's hour retention
   (`G2_ANALYTICS_HOUR_RETENTION_DAYS`) holds the whole window: `90d` at the
   default of 90 days, `1y` from 365 (`offersRange`,
   `src/lib/analytics/traffic.ts`). This is still the user's choice of source,
   not a switch: the range picker lists them under Rollups, and a `?range=`
   the rollups cannot hold falls back with a note naming the setting.
   Prometheus remains the only source past hour retention.

3. **PromQL results are converted to the rollups' `TrafficBucket`, so
   everything downstream is reused.** Three `query_range` calls run in
   parallel, one per chart window, each with `step` set to the range's step
   and the evaluation times at the end of each step (`start = from + step`,
   `end = to`):

   - `sum by (<group>, http_response_status_code) (increase(…_count{sel}[step]))`
     gives requests and the 1xx–5xx counters.
   - `sum by (<group>, le) (increase(…_bucket{sel}[step]))` gives the latency
     histogram.
   - `sum by (<group>) (increase(…_sum{sel}[step]))` gives the latency sum.

   A sample at time `t` becomes the bucket starting at `t − step`. From there,
   `trafficSeries`, `summarise`, `breakdownSeries` and `subtractBucket` run
   unchanged. `increase()` handles counter resets from restarts, and `sum`
   adds up the replicas, so the per-pod caveat of `/g2/stats` does not apply
   here. The mapping has these consequences:

   - Counts come from `increase()`, which extrapolates, so they are rounded to
     whole requests. They are close to the true counts, not equal to them.
   - The histogram is re-bucketed onto the rollup bounds (`LATENCY_BOUNDS_MS`).
     Each rollup bound takes the cumulative count at the largest `le` at or
     below it, and any decrease is clamped to zero. Prometheus's 75, 750 and
     7 500 ms bounds merge into their neighbours. Nothing is known below 5 ms,
     so the rollups' 1 and 2 ms buckets stay empty and a p50 under 5 ms reads
     somewhere between 2 and 5 ms. Percentiles use the interpolation in
     ADR-0013 §4, and the chart is still labelled "estimated".
   - The metric has no maximum. The top of the highest non-empty bucket stands
     in for it in the interpolation, so an estimate in the open bucket above
     10 s is 10 s, as Prometheus's own `histogram_quantile` gives. The page
     shows no maximum.
   - Every selector includes `g2_org_id="<G2_ORG_ID>"` (ADR-0007) and the
     environment's `G2_PROMETHEUS_SELECTOR`. Label values are escaped.

4. **Drill-down offers only what the labels carry: API and status.** A
   Prometheus view can narrow by API (`g2_api_id`) and by a status class or
   code (`http_response_status_code`). It can break down by API, by status
   class, and by code inside a class. Key, method and path are not offered:
   the metric has no key or method label, and `http_route` is the API's listen
   path, which says no more than the API id does. A `?key=`, `?method=` or
   `?path=` under `source=prometheus` is ignored with a note, and those
   breakdown tabs are not shown. The selection rules stay the rollups' own
   (ADR-0013 §6), even where PromQL could combine more, so a link keeps its
   meaning when the source changes. The live inspector is always fed from the
   rollup worker's tail (ADR-0014). Its link stays as it was.

5. **Queries run server-side, with a timeout, and Prometheus's own error is
   shown.** The page's Server Component calls `src/lib/analytics/prometheus.ts`
   (`server-only`). It `POST`s a form-encoded query to `/api/v1/query_range`
   with a 10 s `AbortSignal` timeout and the same `timeout` parameter. A reply
   of `{"status":"error","errorType":…,"error":…}` is shown as
   `Prometheus <errorType>: <error>`, the CLAUDE.md error rule applied by
   analogy. Any other failure (a refused connection, a timeout, a non-JSON
   reply from a proxy) is reported by its kind and HTTP status, never with
   the URL. Every message is scrubbed of the configured password and token
   before it is shown. A failing Prometheus replaces the charts with that
   message. Prometheus's `warnings` are shown under the charts.

## Consequences

- With the default Prometheus retention of 15 days, `90d` and `1y` show only
  the most recent 15 days, and the rest of the chart is empty. The page says
  that the retention in view is Prometheus's. Long ranges need Prometheus
  retention set to cover them, or a long-term store.
- Short ranges need at least two scrapes per step. At a 60 s scrape interval
  the `1h` range's one-minute steps have gaps. The rollups remain the better
  source for recent traffic, which is why they stay the default.
- `contracts/watch.json` gains a `metrics` area over both metrics files. A
  renamed metric, a changed label or new bucket bounds fail the drift check
  and point here.
- If g2way adds `http.request.method` (OTel HTTP semantic conventions make
  it required on this instrument), method drill-down becomes possible from
  Prometheus. This is tracked in `UPSTREAM.md`.
- Saved views, a date-range picker and CSV export must carry `source`. A custom
  range under Prometheus should keep at least two scrapes in every step and
  stay under Prometheus's 11 000 points per series.
