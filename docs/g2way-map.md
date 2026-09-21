# Where to look in g2way

**Read this before opening anything in `../g2way`.** The gateway is a large Rust
workspace; grepping it blindly is the most expensive mistake you can make in this
repo. Use the lookup order in `CLAUDE.md`, and when you do need upstream source,
open the _one file_ named below — never sweep a directory.

Paths are relative to the g2way checkout (`../g2way` by default, `$G2WAY_REPO`
otherwise). Vendored copies of everything under `docs/` are in
`contracts/g2way-docs/` — prefer those, they need no repo.

## Answer it without leaving this repo

| Question                                                      | Look at                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| What fields does an ApiDefinition / KeySession / Policy have? | `contracts/g2way.d.ts` — generated, and it carries g2way's own rustdoc as JSDoc |
| What admin endpoints exist, with params and status codes?     | `contracts/openapi.json`                                                        |
| How does feature X behave?                                    | `contracts/g2way-docs/*.md`                                                     |
| Why is it built that way?                                     | `contracts/g2way-docs/adr/*.md`                                                 |

## Upstream source, by topic

| Topic                                                                 | File                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Admin routes, admin auth, error envelope                              | `crates/g2-admin/src/lib.rs`                                                                           |
| Key CRUD handlers                                                     | `crates/g2-admin/src/keys.rs`                                                                          |
| API-definition + policy CRUD (generic `StoredResource`)               | `crates/g2-admin/src/resources.rs`                                                                     |
| `/g2/node` and `/g2/stats` payload shapes                             | `crates/g2-admin/src/dashboard.rs`                                                                     |
| OpenAPI assembly                                                      | `crates/g2-admin/src/openapi.rs`                                                                       |
| `ApiDefinition` struct + `validate()`                                 | `crates/g2-core/src/api_definition.rs`                                                                 |
| `AuthConfig` tagged enum (all 7 modes)                                | `crates/g2-core/src/api_definition.rs` (`AuthConfig`)                                                  |
| `KeySession`, `RateLimit`, `Quota`, key hashing, Redis key helpers    | `crates/g2-core/src/session.rs`                                                                        |
| `Policy`                                                              | `crates/g2-core/src/policy.rs`                                                                         |
| `AnalyticsRecord` fields                                              | `crates/g2-core/src/analytics.rs`                                                                      |
| GraphQL config (UDG, federation, persisted, cache)                    | `crates/g2-core/src/graphql.rs`, `federation.rs`                                                       |
| Header/URL transforms, body transforms, path rules, CORS, versioning  | `crates/g2-core/src/transform.rs`, `body_transform.rs`, `endpoints.rs`, `security.rs`, `versioning.rs` |
| **Middleware slot order (19 slots, and how versioned APIs split it)** | `crates/g2-middleware/src/chain.rs` — the `ChainBuilder` rustdoc                                       |
| Auth enforcement behaviour, status codes                              | `crates/g2-middleware/src/auth.rs`                                                                     |
| `Storage` trait, Redis impl, Lua rate/quota scripts                   | `crates/g2-storage/src/lib.rs`, `redis.rs`                                                             |
| Analytics sinks (incl. the Redis list the ingest worker drains)       | `crates/g2-telemetry/src/analytics.rs`                                                                 |
| Gateway CLI flags and env vars                                        | `crates/g2way/src/main.rs`                                                                             |
| k8s manifests, ports, smoke script                                    | `deploy/k8s/`                                                                                          |

## Invariants the OpenAPI document does not tell you

These are load-bearing for the dashboard and easy to get wrong:

- **Writes are not live.** `POST`/`PUT` on `/g2/apis` and `/g2/policies` only touch
  storage. Nothing changes on the data plane until `POST /g2/reload`, which
  broadcasts on Redis pub/sub so every pod rebuilds its route table. Surface this
  in the UI; do not hide it.
- **`GET /g2/keys` returns key _hashes_, not keys.** A raw key exists exactly once,
  in the `POST /g2/keys` 201 response. Anything richer (labels, owner, notes) is
  the dashboard's own data.
- **`/g2/stats` is process-local** and resets on restart. With more than one replica
  it is a per-pod sample, not a cluster total — use analytics or Prometheus for those.
- **Two listeners.** Proxy traffic and the admin API are separate ports. `/hello`
  and `/ready` live on the proxy; `/g2/health` and `/metrics` on the admin port and
  are the only unauthenticated admin routes.
- **Admin auth is one shared secret** in `X-G2-Authorization`, compared as SHA-256.
  There are no users and no RBAC upstream — that is entirely this dashboard's layer,
  and the secret must never reach the browser.
- **Missing and wrong secret both return 403**, and the 404 fallback sits inside the
  authed router, so unknown paths also read 403 to an outsider. Do not build UI that
  distinguishes them.
- **`org_id` is on every record and Redis key** but is always `DEFAULT_ORG_ID`
  (`"default"`) today. Carry it everywhere; never hardcode the literal.
- **Writes take their org from the body, not the query.** `POST`/`PUT` of API
  definitions, policies and keys file the record under the body's `org_id`
  (`resources.rs` `create`/`put`, `keys.rs`), and a body without one is
  serde-defaulted to `DEFAULT_ORG_ID`, whatever `?org_id=` says (`PUT
/g2/keys/{key}` takes both: the query locates the hash, the body files it).
  `GET`/`DELETE` take `?org_id=`. The BFF sets both (ADR-0007).
- **Redis key schema is `g2:{org_id}:{kind}:{id}`.** Analytics records accumulate at
  `g2:{org}:analytics:records` — but only when the gateway runs with
  `--analytics-sink redis_list`.
- **A definition with no `auth` block is protected, not open.** The default is
  `auth_token` on `Authorization`; keyless must be declared explicitly.
- **Response conventions**: mutations return `{"id", "action"}` where action is
  `added`/`modified`/`deleted`; errors are always `{"error": "..."}`; 409 on POST of
  an existing id; 503 `{"error":"storage unavailable"}` when Redis is down.
- **The OpenAPI document declares neither shape above.** Error responses and the
  mutation `{"id", "action"}` bodies are listed with no content schema
  (`content?: never` in `g2way.d.ts`), so `src/lib/g2/errors.ts` types the error
  envelope itself (`GatewayError`) and create calls resolve to `undefined`.
- **`/g2/node` describes one pod, and not every API fully.** It is the live
  route table of whichever replica answered, so behind a Service each call may
  come from a different pod. For a _versioned_ API its `live_targets` are the
  unused base target and `target_health`, `circuit_breaker`,
  `service_discovery` and `graphql_schema_sync` are null — each version keeps
  its own, and none of that is surfaced. Its body is hand-typed in
  `src/lib/g2/node.ts` (see `UPSTREAM.md`).

## Keeping this file honest

If you learn something upstream that belongs here, add it — a line here saves a
future session an expensive search. If g2way changes underneath a row,
`npm run check:g2way` will say so; see `UPSTREAM.md`.
