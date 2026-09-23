# ADR-0012: Analytics ingest: draining the gateway's record list into rollups

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0001 §3–4, ADR-0003, ADR-0007

## Context

M6 starts with an ingest worker. ADR-0001 §4 chose g2way's Redis record feed as
the primary analytics source. It did not say how the feed is read, where the
reader runs, what it keeps, or what happens when it fails. Upstream facts
(`crates/g2-core/src/analytics.rs`, `crates/g2-telemetry/src/analytics.rs`,
`crates/g2-storage/src/redis.rs`):

- With `--analytics-sink redis` (`G2_ANALYTICS_SINK=redis`; earlier notes here
  said `redis_list`, which g2way rejects), every gateway replica batches its
  records (up to 512, at least once a second) and `RPUSH`es them as JSON
  strings to `g2:{org_id}:analytics:records`, one list per org.
- The same atomic pipeline `LTRIM`s the list to its newest 100 000 entries
  (`RedisListSink::DEFAULT_MAX_RECORDS`, not configurable). Without a
  drainer, the **oldest** records fall off.
- A pump drains with `Storage::list_drain`, which is `LPOP key count`
  (Redis 6.2+): atomic, from the head, oldest first.
- g2way's own pipeline is best effort. A batch the sink fails to deliver is
  dropped and logged. Analytics never applies backpressure to the proxy.
- `AnalyticsRecord` has no id. It is not in the OpenAPI document, because no
  admin endpoint returns it, so `contracts/g2way.d.ts` has no type for it.

## Decisions

1. **The feed is read from each environment's Redis, named in config.**
   `G2_REDIS_URL` in the single-gateway form (the same name g2way reads, so one
   `.env` drives both), and `G2_ENV_<ID>_REDIS_URL` per environment. It must be
   `redis://` or `rediss://`. It is optional: without it, that environment has
   no analytics. It can carry a password, so it is server-only like the admin
   secret. `GatewayTarget.toJSON` omits it, and config errors never echo it.
   The dashboard issues exactly two commands, on exactly one key per
   environment: `LPOP g2:{org}:analytics:records <n>` and `LLEN` on the same
   key. The org is `getOrgId()` (ADR-0007). It writes nothing to the gateway's
   Redis, so ADR-0001 §3 stands. This is the one sanctioned read of the gateway's
   Redis. Other gateway state (key usage, for one) still waits for an admin
   endpoint.

2. **The worker runs inside the dashboard server by default.**
   `src/instrumentation.ts` starts it after migrations, in the Node.js runtime
   only, once per process (a `globalThis` guard survives dev reloads). A single
   container therefore needs nothing else. `G2_ANALYTICS_INGEST=off` turns it
   off in the server. `npm run ingest` (`make ingest`) runs the same loop as a
   separate process, for deployments that want it apart from the web tier.
   Several drainers are safe at once: several replicas, or the server plus a
   standalone worker. `LPOP` hands each record to exactly one of them, and
   every rollup write is an additive upsert.

3. **Draining is at-most-once, and the loss window is one batch.** The worker
   pops up to `G2_ANALYTICS_BATCH` records (default 1000) and folds them into
   rollup rows in memory. It then writes those rows and its own counters in one
   database transaction. After a pop, the batch exists only in the worker's
   memory:
   - **Database error**: the worker retries the same batch with backoff and
     pops nothing more until it lands.
   - **Graceful stop**: the loop finishes the batch in hand before returning.
   - **Hard crash between the pop and the commit**: that batch, at most
     `G2_ANALYTICS_BATCH` records, is lost.

   We rejected at-least-once. It needs an in-flight list per worker (`LMOVE`
   into a processing key), which puts dashboard state in the gateway's Redis.
   Replay after a crash then double-counts unless every record has an id, and
   records have none. For a pipeline whose producer already drops failed
   batches and caps the list, bounded loss on a crash is the matching guarantee.
   UPSTREAM.md asks for a record id. With one, at-least-once plus dedupe becomes
   possible and would need a new ADR.

4. **Records are validated, and a bad one is counted, not fatal.**
   `parseAnalyticsRecord` (`src/lib/analytics/record.ts`) checks each element
   against the shape in `crates/g2-core/src/analytics.rs`. The type is written
   by hand there, as `node.ts` does for `/g2/node`, until g2way publishes the
   schema (UPSTREAM.md). The parser tolerates unknown fields and absent
   optionals, as serde does. An element that is not JSON, lacks a required
   field, or names another org is dropped. It adds to `records_rejected`, with
   the reason (never the element) in `last_rejection`.

5. **Rollups: one wide table, two granularities, one dimension per row.**
   `analytics_rollups` has one row per org, environment, `bucket_seconds`,
   `bucket_start`, `api_id`, `dimension` and `value`, with a unique index on
   all seven.
   - **Granularities**: `bucket_seconds` is 60 (minute) or 3600 (hour). Both
     are written at ingest, so no compaction job exists and a chart at either
     resolution reads one granularity.
   - **Dimensions**: each record adds to five rows per granularity:
     - `api`: value `''`, the API's total;
     - `key`: the `key_hash`, or `''` when there was none; `label` keeps the
       latest `key_alias` seen;
     - `method`;
     - `status`: the exact code (status class is its first digit);
     - `path`.

     A breakdown by one dimension within an API therefore sums to that API's
     total. Cross-dimension questions (key × path) are not answerable, by
     design. That keeps the row count linear in cardinality.

   - **Measures**, all additive, so a coarser question is a `SUM`:
     - `requests`;
     - `status_1xx` to `status_5xx`;
     - `latency_sum_ms`, and `latency_max_ms` (merged with `max`);
     - `upstream_requests` and `upstream_latency_sum_ms`, over the records
       that reached the forwarder;
     - `request_bytes` and `response_bytes`, where a `Content-Length` was
       present;
     - a latency histogram: per-bucket, non-cumulative counts at fixed upper
       bounds of 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000 and
       10 000 ms, plus `latency_over`. Percentiles are estimated from it at
       query time. The exact percentile needs raw records, which are not kept.
   - **Paths are bounded.** A path is truncated to 512 characters. Within one
     batch, one API and one bucket, the 200 busiest distinct paths are kept
     and the rest fold into the value `(other)`. Real paths start with `/`,
     so it cannot collide. The cap is per batch, so a busy minute can still
     hold more than 200 path rows. Templating paths (`/users/{id}`) is M6
     drill-down work.
   - Counters are `bigint` in Postgres and `integer` (64-bit) in SQLite. Both
     read back as `number` (ADR-0003 §2).

6. **Only rollups are kept, never raw records.** Client IP and User-Agent are
   read by nothing and stored nowhere. The worker is the list's only
   consumer: whatever it pops is gone from Redis. So the live request
   inspector (a later M6 task) must be fed by this worker, from the batch in
   hand, and never by a second reader of the list, which would steal records
   from the rollups.

7. **Retention is pruned by the worker.** Once an hour it deletes minute rows
   older than `G2_ANALYTICS_MINUTE_RETENTION_DAYS` (default 3) and hour rows
   older than `G2_ANALYTICS_HOUR_RETENTION_DAYS` (default 90), for its own org.
   A late record for an already pruned bucket is ingested and pruned again on
   the next pass.

8. **Ingest health is a table, not a log line.** `analytics_ingest_state`
   has one row per org and environment. It holds `records_ingested`,
   `records_rejected`, `batches`, `last_drained_at` (the last non-empty pop),
   `last_record_at` (the newest record timestamp seen), `backlog` (the `LLEN`
   after the last drain) and `last_error` / `last_error_at` (Redis or
   database failures). The traffic pages use it to tell "not configured",
   "gateway not sending" and "worker failing" apart. A backlog above 80 % of
   g2way's 100 000 cap means the gateway is dropping the oldest records.

## Consequences

- The dashboard gains its first long-running process, and a dependency on the
  `redis` client. Redis errors are caught and recorded, never thrown out of
  the loop. The server stays up with Redis down.
- `analytics_rollups` is the query surface for the rest of M6. A chart sums
  `requests` and the histogram columns over `bucket_start` ranges for one
  `bucket_seconds` and one `dimension`, filtered by `api_id` where it drills.
- In k8s the gateway must run the `redis` sink (UPSTREAM.md: the manifests
  choose `otlp_logs`), and the dashboard must reach the same Redis.
- A crash can lose one batch, and a stopped worker lets the gateway's cap drop
  the oldest records. Neither is silent: `analytics_ingest_state` shows the
  backlog and the last error.
- The record shape is watched through the `analytics` area in
  `contracts/watch.json`. A new field needs a parser change and, if it should be
  charted, a column and a migration.
