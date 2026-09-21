# ADR-0001: Foundational stack choices

Date: 2026-09-10 · Status: accepted

## Context

g2way-dashboard is the control plane UI for the g2way gateway. The gateway
exposes a complete admin API on its own listener, authenticated by a single
shared secret in `X-G2-Authorization`, and holds no user model, no RBAC, no audit
log and no analytics storage. Everything an operator expects from a dashboard
above "call the admin API" has to live here.

Two constraints shape the stack. First, that shared secret is all-or-nothing:
whoever holds it controls the gateway, so it must never reach a browser. Second,
this is a free, self-hosted product — a first run should not require standing up
infrastructure.

## Decisions

1. **Next.js (App Router), not a static React SPA.** The decisive reason is the
   secret: route handlers under `src/app/api/g2/**` run server-side, so the
   dashboard can talk to the gateway without ever shipping credentials to the
   client. A Vite SPA would need a separate proxy service to achieve the same
   thing, which is the same BFF with extra deployment steps. Server Components,
   streaming, and a single container to deploy beside the gateway follow for free.

2. **TypeScript strict, with all gateway types generated.** Every request and
   response shape crossing the gateway boundary comes from `contracts/g2way.d.ts`,
   generated from the gateway's own OpenAPI document. Hand-written mirrors of
   `ApiDefinition` would rot silently; generated ones fail the build. See ADR-0002.

3. **SQLite by default, Postgres by driver swap, via Drizzle.** Dashboard-owned
   state — users, roles, audit log, config history, analytics rollups, portal
   accounts — is relational and queried in ways Redis handles badly. SQLite makes
   first run a no-op; one Drizzle schema serves both, so choosing Postgres later
   is a connection-string change, not a rewrite. We deliberately do **not** store
   dashboard concepts in the gateway's Redis: it is the gateway's data plane.

4. **Analytics from both the Redis record feed and, optionally, Prometheus.**
   g2way's `RedisListSink` accumulates full `AnalyticsRecord`s at
   `g2:{org}:analytics:records` explicitly for an external pump to drain; that
   gives per-key and per-path detail and a live request inspector, which
   `/metrics` cannot. Prometheus stays an optional datasource for long-range
   aggregates where one already exists. `/g2/stats` is process-local and resets on
   restart, so it is a node view only, never a cluster total.

5. **Tailwind + shadcn/ui.** Componentry we own outright, no runtime theme
   dependency, and a design system that survives being extended over many
   sessions.

6. **A `Makefile` is the entry point, not bare npm scripts.** `make check` is the
   gate, exactly as in g2way. Same muscle memory across both repos, and it gives
   the drift check somewhere natural to live.

## Consequences

- The dashboard is a Node service, not a static bundle. That is the price of
  holding the secret safely, and it is the right price.
- A test asserts the admin secret never appears in the client bundle. Treat a
  failure as a security bug, not a lint error.
- Any client component needing gateway data goes through the BFF; none of them
  import gateway-credential modules directly.
- Two datastores exist in a full deployment (the gateway's Redis, the dashboard's
  SQL). They never overlap: the gateway owns runtime config and counters, the
  dashboard owns everything about people and history.
