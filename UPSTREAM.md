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

- [ ] **The Policy schema is looser than `Policy::validate`.** _Found 2026-09-23
      (M4)._ `RateLimit.requests`/`per_seconds` and `Quota.max`/
      `renewal_rate_secs` are `minimum: 0`, but `validate` refuses zero ("use
      None for unlimited, never zero"), and `Policy.active` / `access` carry no
      `default` (serde: `true` / `{}`, and an empty `access` grants every API in
      the org). So a schema-valid policy can still be refused with 400, and the
      dashboard restates those rules in `policyProblems()` and `summarisePolicy()`
      (`src/lib/policies/`). Needs `#[schema(minimum = 1)]` on the four fields
      and schema defaults in `crates/g2-core/src/policy.rs` (see the serde-defaults
      item above); then drop the duplicated checks. _Not a blocker._

- [ ] **No atomic key rotate endpoint.** _Found 2026-09-23 (M4)._ The
      dashboard rotates a key as three calls: read the session by hash, create
      a key with it (`POST /g2/keys`), then delete the old hash. The BFF
      orchestrates them at `POST /api/g2/keys/{hash}/rotate` (ADR-0009). It is
      not atomic: if the delete fails after the create succeeded, both keys work
      until someone deletes the old one, and the dashboard can only say so. Ask
      for `POST /g2/keys/{key}/rotate` (honouring `?hashed=true`) that swaps the
      session to a fresh key in one storage transaction and answers like create,
      ideally with an optional grace period during which the old key still
      works. Then proxy it and retire `src/lib/g2/rotate-key.ts`; its test fails
      as soon as the spec gains a `/rotate` path. Related, the same gap as the
      error-envelope item: `GET /g2/keys` and the `POST /g2/keys` 201 declare no
      body, so `src/lib/keys/session.ts` parses both at runtime. _Blocks one
      task in M4 (native rotate); the BFF orchestration works meanwhile._

- [ ] **No key listing with sessions, or at least aliases.** _Found 2026-09-23
      (M4)._ `GET /g2/keys` answers hashes only (see the item above), so
      searching `/keys` by alias, policy or state costs one
      `GET /g2/keys/{hash}?hashed=true` per key. The dashboard caps that at
      `KEY_SCAN_LIMIT` = 200 reads per search (`src/lib/g2/keys.ts`). Past the
      cap, the search and "select every match" cover only the keys read, and
      say so. Ask for `GET /g2/keys?include=summary` (or a separate path),
      paged, that returns per hash the non-secret fields a list needs:
      `alias`, `active`, `expires`, `apply_policies`. It must never include
      `hmac`/`basic_auth`. Server-side `alias`/`policy`/`active` filters would
      do as well. Then `loadKeySearch`/`loadKeyMatches` drop the per-key reads
      and the cap. _Blocks one task in M4._

- [ ] **`GET /g2/apis` lists stored definitions only.** _Found 2026-09-23 (M4)._
      Definitions loaded from `--apps-dir` files (ADR-0002) never appear in it,
      so the access matrix cannot tell a file-loaded `api_id` from a deleted
      one: both show as "not found", with a note, and can be added by id. Ask
      for a listing of the live route table, or a `source` field on each
      definition (file or storage). Then `danglingApis()` in
      `src/lib/designer/access.ts` can be exact. _Not a blocker._

- [ ] **No per-key usage endpoint.** _Found 2026-09-23 (M4)._ A key's live
      quota counter, its reset time and its current rate-window count live only
      in g2way's storage (the `Quota` rustdoc says so); the admin API has no path
      that reads them, and `/g2/stats` is per API and process-local. The
      dashboard will not read g2way's Redis directly, so M4's live usage task is
      blocked. Ask for a read-only `GET /g2/keys/{key}/usage` (honouring
      `?hashed=true`, admin-authenticated) answering, for the limits in effect
      (the applied policy's when there is one), a `quota` object with `max`,
      `used`, `remaining` and `resets_at`, and a `rate` object with `requests`,
      `per_seconds` and `current`, each `null` when unlimited, with a typed body
      in the OpenAPI. Then the BFF proxies it and the Usage panel on
      `/keys/view/[hash]` (`src/components/keys/key-usage.tsx`), which today
      shows only the configured limits, adds the live numbers and a reset
      countdown; `src/lib/keys/usage.test.ts` fails as soon as the spec gains a
      `usage` path. _Blocks one task in M4._

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
