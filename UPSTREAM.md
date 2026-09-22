# Upstream (g2way) journal

g2way is the driver for this project. Every time a watched area of it changes,
`npm run sync:g2way` regenerates `contracts/` and appends an entry below.

Entries are append-only history — never rewrite one. Tick the `TODO` boxes as the
dashboard catches up; those are the open work items this journal exists to track.

Watched areas are defined in `contracts/watch.json`; the recorded fingerprints live
in `contracts/g2way.lock.json`. Run `npm run check:g2way` to see whether we are behind.

## Known upstream dependencies (open)

Found while planning M0. These are gateway-side gaps the dashboard hits; each
blocks or shapes a milestone here. They are not drift — nothing changed under us
— but they belong in the same journal, because the fix for each is an upstream
commit this project is waiting on.

- [ ] **Admin port is exposed on no Service.** `deploy/k8s/gateway.yaml` sets
      `G2_ADMIN_LISTEN=0.0.0.0:9696` and comments that the port is deliberately
      not in the Service; only `proxy` is. An in-cluster dashboard therefore
      cannot reach the admin API at all. Needs either an `admin` port on the
      g2way Service (guarded, since the secret is the only thing protecting it)
      or the dashboard deployed as a sidecar. _Blocks M1 and M11 in minikube;
      local development via `kubectl port-forward` is unaffected._

- [ ] **k8s analytics sink is `otlp_logs`, not `redis_list`.** The M6 ingest
      worker drains `g2:{org}:analytics:records`, which is only populated when the
      gateway runs with `--analytics-sink redis_list`. The deployed manifests
      choose the OTLP sink. Needs a gateway able to feed both, or a deployment
      choice. _Blocks M6 in-cluster._

- [ ] **No cache-flush endpoint.** Already noted as open in g2way's own progress
      log, which observes that the storage prefix scan is ready for it. Until it
      exists, the dashboard can show cache configuration but cannot offer a flush
      action. _Blocks one task in M7._

- [ ] **`GET /g2/keys` returns hashes only.** A raw key exists exactly once, in
      the `POST /g2/keys` 201 response. Not a blocker and arguably correct
      security design — recorded because it is the _reason_ M4 keeps its own key
      metadata table, and that rationale should outlive whoever wrote it.

- [ ] **The OpenAPI document omits the error envelope and mutation bodies.**
      Every error response, and the `{"id", "action"}` body of POST/PUT/DELETE,
      is declared without a content schema. The typed client therefore parses
      `{"error"}` itself (`GatewayError` in `src/lib/g2/errors.ts`) and cannot see
      the returned `action`. Needs `body = ErrorBody` / a mutation-result schema on
      the utoipa `responses(...)` annotations in `crates/g2-admin`. _Shapes M3/M4
      save flows; not a blocker._

- [ ] **The OpenAPI document omits serde defaults.** _Found 2026-09-23 (M3)._
      `ApiDefinition.active` is `#[serde(default = "default_true")]`, but the
      schema has no `"default": true`, so the generated type reads as "absent =
      falsy". The dashboard hard-codes the defaults it relies on in `summarise()`
      (`src/lib/apis/list.ts`), and the map lists them. Needs a schema default
      on each defaulted field in `crates/g2-core` (`#[schema(default = …)]`);
      then derive the defaults from `contracts/openapi.json`. _Shapes the M3 designer; not a blocker._

- [ ] **`/g2/node`, `/g2/version` and `/g2/health` have no response schema.**
      `/g2/node` is an untyped `serde_json::json!` in
      `crates/g2-admin/src/dashboard.rs`, and all three `responses(...)` omit
      `body = …`, so `g2way.d.ts` types them `content?: never`. The Gateway page
      therefore hand-types them in `src/lib/g2/node.ts` and parses every body at
      runtime (`PayloadShapeError` names the field that moved). Needs `ToSchema`
      structs (`NodeInfo`, `NodeRoute`, `SyncStatus`, a `BreakerState` enum) plus
      `body = …` upstream; then delete the hand-written types and keep the
      parser only if it still earns its place. _Not a blocker._

- [ ] **`/g2/stats` is process-local** and resets on restart, so with more than
      one replica it is a per-pod sample rather than a cluster total. Cluster-wide
      numbers must come from the analytics feed or Prometheus. Shapes M6; not a
      defect.

## 2026-09-10 — g2way (none) → 9f0b811

Initial lock against g2way `9f0b81166d0903f09e265acc8769b33a589e7173`. All 12 watched areas recorded; no drift to report yet.

## 2026-09-10 — g2way 9f0b811 → 66aa49b

Upstream moved, but no watched area changed. Lock advanced; nothing to do here.

## 2026-09-23 — g2way 66aa49b → 61a4975

Watched areas changed: **admin-api**

### admin-api

- Drives: src/app/api/g2/**, src/lib/g2/**, contracts/g2way.d.ts
- Action: Re-copy the spec and regenerate types; check the BFF proxy allowlist for new or removed endpoints.
- [x] TODO: Re-copy the spec and regenerate types; check the BFF proxy allowlist for new or removed endpoints.
      _Done 2026-09-23: only `info.license` changed (MPL-2.0 → MIT); no endpoints moved, and no BFF allowlist exists yet._

## 2026-09-23 — g2way 61a4975 → 61a4975

Newly watched: **file-loader** — first fingerprint recorded; nothing to catch up on.
