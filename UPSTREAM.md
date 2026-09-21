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

- [ ] **`/g2/stats` is process-local** and resets on restart, so with more than
      one replica it is a per-pod sample rather than a cluster total. Cluster-wide
      numbers must come from the analytics feed or Prometheus. Shapes M6; not a
      defect.

## 2026-09-10 — g2way (none) → 9f0b811

Initial lock against g2way `9f0b81166d0903f09e265acc8769b33a589e7173`. All 12 watched areas recorded; no drift to report yet.

## 2026-09-10 — g2way 9f0b811 → 66aa49b

Upstream moved, but no watched area changed. Lock advanced; nothing to do here.
