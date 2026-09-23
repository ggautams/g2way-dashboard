# ADR-0014: The live request inspector

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0005, ADR-0007, ADR-0010, ADR-0012

## Context

M6 asks for a live request inspector: a tail of recent requests. ADR-0012 §6
settles where the requests come from. The ingest worker is the only reader of
the gateway's record list, and `LPOP` hands each record to exactly one
drainer, so a second reader would steal records from the rollups. The
inspector must be fed from the worker's batch in hand (`drainOnce`'s parsed
`records`, before `rollupBatch`).

That leaves three questions:

- **Where the tail lives.** The worker runs in the web server by default, but
  ADR-0012 §2 also allows it as a separate process (`npm run ingest`, with
  `G2_ANALYTICS_INGEST=off` on the web tier), and several drainers at once
  (web replicas, or the server plus a standalone worker). Each drainer sees
  only the records it popped.
- **What of a record may be kept and shown.** A record carries the client IP,
  the User-Agent, the raw path (no query string: g2way records none), the key
  hash and alias, status, latencies and body sizes. ADR-0012 §6 promised that
  IP and User-Agent are stored nowhere.
- **Who may see it**, and how the page stays live.

## Decisions

1. **The tail is a small table in the dashboard database, not process
   memory.** `analytics_tail` (migration `0008_analytics_tail`) has one row
   per kept request, per org and environment.

   Rejected: an in-memory ring buffer in the worker. It is free when the
   worker is in the server, but:
   - it is empty whenever the worker runs out of process, the deployment
     ADR-0012 §2 offers for separating the web tier;
   - with several drainers, each page load would show whichever replica's
     share of the traffic that replica happened to pop.

   A database tail works the same in every topology the worker supports,
   because every drainer writes to the same place, and it needs no new
   transport between the worker and the web tier. Its cost is bounded by §2.

2. **Bounded, and pruned aggressively.**
   - **Per batch:** the worker keeps at most `G2_ANALYTICS_TAIL_ROWS` (default
     200, 0 to 1000; 0 keeps none) of the batch's records, the newest by the
     gateway's timestamp. It skips records already older than
     `TAIL_MAX_AGE_MS` (15 minutes), so catching up on a backlog does not fill
     the tail with requests no one will be shown.
   - **Same transaction:** the rows are inserted in the batch's rollup
     transaction (`writeIngestBatch`). In that transaction the environment's
     tail is also cut back to its newest `G2_ANALYTICS_TAIL_ROWS` rows, and
     rows older than 15 minutes are deleted. A retried batch cannot leave
     its requests in twice, and a lost batch (ADR-0012 §3) leaves none.
   - **By age:** once a minute (`TAIL_PRUNE_EVERY_MS`) the worker also
     deletes the org's rows past 15 minutes in every environment. An
     environment that has gone quiet therefore empties too.
   - **Reads:** the inspector reads only the last 15 minutes and at most
     `LIVE_LIMIT` (100) rows.

   So each environment holds at most about `G2_ANALYTICS_TAIL_ROWS` rows. The
   write cost is one multi-row insert and one small delete per batch, plus
   one delete a minute. At high rates the tail is a sample: the newest of
   each batch, not every request. The page says so. The setting is read by
   whichever process runs the worker. The web tier cannot know it when the
   worker runs elsewhere, so an empty tail is explained by the ingest health
   panel, which the page shows first, as `/analytics` does.

3. **A projection, never the record.** `tailEntries`
   (`src/lib/analytics/tail.ts`) keeps:
   - time, API, method and status;
   - the raw path, and the template the rollups filed it under
     (ADR-0012 §5). Both are truncated to 512 characters, as in the rollups;
   - latency and upstream latency;
   - key hash and alias;
   - request and response `Content-Length`.

   **Client IP and User-Agent are dropped before the write** and never
   stored. ADR-0012 §6 still holds for them. Tests pin that neither reaches
   the table.

   ADR-0010's rules apply as follows:
   - **Query strings.** Its URL masking targets query parameters and
     userinfo. g2way records neither, so there is nothing to mask.
   - **Key hash.** A key hash is an identifier, not a credential. `/keys`
     lists hashes to every role with `keys:read`. The inspector shows keys as
     `/keys` does: dashboard label, else alias, else short hash. Without
     `keys:read` it omits the key entirely (`toLiveRequest`), and ignores a
     `?key=` filter, as the drill-down does.
   - **Path segments.** A raw path can still carry personal data
     (`/users/alice@example.com`) or a token-shaped segment. The permission
     in §4 is the control for that. Masking segments is left as a follow-up
     (ROADMAP M12).

4. **A new permission, `analytics:inspect`, for editor and up (ADR-0005
   amended).** `/analytics` shows aggregates with templated paths, and stays
   on `gateway:read`. The inspector shows individual requests with raw paths
   and keys, which is a different kind of data. The rule is the one
   `apis:test` used (ADR-0011 §3): viewers see aggregates; roles that operate
   the gateway see individual traffic.
   - **Where it is checked.** The page calls
     `requirePermission('analytics:inspect')`. The poll route checks it too
     and answers 403 in the `{"error"}` envelope.
   - **Links.** The nav entry and the "Live requests for this selection" link
     on `/analytics` are hidden from roles without it.
   - **Tests.** `check:bundle` asserts a viewer's 403s on both the page and
     the route.

5. **Polling, not SSE.** `GET /api/analytics/live`
   (`src/app/api/analytics/live/route.ts`, behind `withUser`) answers the
   newest matching rows as one JSON snapshot. The client component
   (`LiveTail`) polls it every `LIVE_POLL_MS` (2 s, the worker's idle
   pause).
   - **Why polling.** Rows arrive once per drain, so nothing is lost by
     polling at the drain rate. A snapshot of at most 100 rows needs no
     cursor, so it is immune to the out-of-order commits of several writers.
     An SSE stream would hold a connection and a database poll loop per open
     tab on the server anyway.
   - **Pause and resume.** Pause stops polling and freezes the list.
     Polling also skips while the tab is hidden.
   - **Failures.** A failed poll shows the route's own `error` message and
     keeps the last rows.
   - **First render.** The server renders the first snapshot through the
     same loader (`loadLiveRequests`), so the page is useful without
     JavaScript.
   - **What the route reads.** The route reads the dashboard database only.
     It never calls the gateway or Redis, so the admin secret and
     `G2_REDIS_URL` never come near it.
   - **Environment and org.** The environment is the user's selected one
     (the cookie), and the org comes from `getOrgId()` (ADR-0007).

6. **Filters are the drill-down's.** The page and the route parse
   `parseDrill`'s parameters: `?api=` and one of `?key=`, `?status=` (a class
   or a code), `?method=` or `?path=`.
   - `?path=` is a template, matched against `path_template`. The same URL
     therefore selects the same traffic on `/analytics` and on
     `/analytics/live`, and each page links to the other with the selection
     kept.
   - Every value in the table links to the inspector narrowed to it.
   - The tail never holds `(other)` (the rollups' fold for paths past the
     cap), so that path value matches nothing here.

## Consequences

- The dashboard database now holds recent individual requests, minus IP and
  User-Agent, for up to about 16 minutes. Backups taken in that window
  contain them.
- Editors see raw request paths and key names. Viewers do not see the
  inspector at all.
- A busy environment's tail is a sample. Exact per-request history would
  need a real log store, which is out of scope. With a record id
  (UPSTREAM.md), rows could be correlated with gateway logs.
- Not built:
  - a client IP or User-Agent column (it would reverse ADR-0012 §6 and needs
    its own decision);
  - masking of token-shaped path segments;
  - a request detail view;
  - filtering on two dimensions at once.
