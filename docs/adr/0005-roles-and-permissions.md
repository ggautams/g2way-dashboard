# ADR-0005: Roles, permissions and their enforcement

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0003, ADR-0004

## Context

ADR-0004 stores a role on every account (`owner`, `admin`, `editor`, `viewer`,
`portal-dev`) but enforces only "signed in". The BFF holds the gateway's admin
secret, so until roles are enforced every account is a full gateway admin. The
gateway itself has one shared secret and no notion of users (ADR-0001 §3), so the
dashboard is the only place a role can be enforced.

## Decisions

1. **Roles grant permissions; code checks permissions, never role names.**
   `src/lib/auth/rbac.ts` is universal and dependency-free (the shell uses it to
   hide what a role cannot use). The matrix, pinned by `rbac.test.ts`:

   | Permission       | viewer | editor | admin | owner | portal-dev |
   | ---------------- | :----: | :----: | :---: | :---: | :--------: |
   | `gateway:read`   |   ✓    |   ✓    |   ✓   |   ✓   |            |
   | `apis:read`      |   ✓    |   ✓    |   ✓   |   ✓   |            |
   | `policies:read`  |   ✓    |   ✓    |   ✓   |   ✓   |            |
   | `keys:read`      |   ✓    |   ✓    |   ✓   |   ✓   |            |
   | `apis:write`     |        |   ✓    |   ✓   |   ✓   |            |
   | `policies:write` |        |   ✓    |   ✓   |   ✓   |            |
   | `gateway:reload` |        |   ✓    |   ✓   |   ✓   |            |
   | `graphql:sync`   |        |   ✓    |   ✓   |   ✓   |            |
   | `keys:write`     |        |        |   ✓   |   ✓   |            |
   | `users:manage`   |        |        |   ✓   |   ✓   |            |
   | `audit:read`     |        |        |   ✓   |   ✓   |            |

   Key writes sit with admin, not editor: minting or revoking a credential is an
   access decision, not a configuration edit. `portal-dev` is a developer-portal
   account (M10) and gets no gateway admin access, reads included. Owner and admin
   hold the same permissions and differ only in whom they may manage (§4).

2. **The BFF maps every gateway operation to a permission, default deny.**
   `src/lib/g2/operation-permissions.ts` keys each operation as
   `"<METHOD> <spec path template>"`. The proxy checks it after its 404/405
   allowlist and before the CSRF check and the gateway call; a role without the
   permission, or an operation with no entry, gets 403 in the gateway's
   `{"error": "..."}` envelope naming the role, the permission and the operation.
   `operation-permissions.test.ts` iterates every operation the proxy compiles
   from `contracts/openapi.json` and fails for any without an entry (and for stale
   entries), so a `sync:g2way` that adds an endpoint turns the gate red until
   someone decides who may call it. The role comes from `withUser`, which reads the
   account fresh from the database per request (ADR-0004 §3): a demotion applies
   on the next request.

3. **Pages enforce with `requirePermission()`; the nav only hides.** Nav sections
   declare a `permission`; the sidebar and command palette drop sections the role
   lacks, and the degraded banner renders only for `gateway:read`. That is
   cosmetic. The page calls `requirePermission(permission)`
   (`src/lib/auth/session.ts`), which answers a real 403 through Next's
   `forbidden()` and `src/app/forbidden.tsx`. `forbidden()` needs
   `experimental.authInterrupts`; we accept an experimental flag because `next`
   is pinned exactly and the alternative (a 200 page saying "forbidden") lies to
   every client and test. `(app)/pages.test.ts` fails if a ready section's page
   does not call `requirePermission` with its declared permission. Server actions
   check again themselves: an action is a public endpoint whatever page rendered
   it.

4. **Who may manage whom.** `userChangeDenial(actor, target, nextRole)`:
   - the actor needs `users:manage`;
   - nobody changes their own account (role or enabled state), so nobody can
     escalate themselves or lock themselves out; another owner does it;
   - the actor must be able to assign both the target's current role and the new
     one. Owners assign every role, so they manage everyone, other owners
     included. Admins assign only `editor`, `viewer` and `portal-dev`: they cannot
     create, promote to, or modify an admin or owner.

   Enabling and disabling follow the same rule with the target's current role.
   Accounts are disabled, not deleted, in this task (the audit trail snapshots the
   actor anyway, ADR-0003).

5. **The org always keeps an active owner, enforced in the data layer.**
   `createUser` and `updateUser` (`src/lib/db/users.ts`) take one write lock per
   org (SQLite `BEGIN IMMEDIATE`; Postgres `pg_advisory_xact_lock` on
   `g2dash:users:<org>`), then re-read the actor, the target and the count of
   active owners inside it, and apply §4 plus the invariant: an active owner may
   not be demoted or disabled while they are the only one. Because the actor is
   re-read under the lock, two owners demoting each other at once cannot both
   succeed. With the self-change rule the invariant is not reachable through §4
   alone today; it is kept as the database-level backstop, so a future rule
   change (say, letting an owner step down) cannot break it. Tested on SQLite, on
   PGlite and across two SQLite connections; the live node-postgres race test runs
   under `make test-pg`.

6. **Writes return before/after.** Every user-management write returns the
   account before and after (`UserWriteResult`), which is what the audit log
   records; the server actions are the single place that hook goes.

## Consequences

- Adding a gateway endpoint upstream is a two-line decision here, forced by the
  test, never a silent grant.
- Adding a permission means a new entry in `PERMISSIONS`, the matrix test and this
  ADR's table. Roles are text (ADR-0003 §2), so a new role needs no migration,
  but it does need entries in `ROLE_PERMISSIONS` and `ASSIGNABLE_ROLES` (the types
  require both).
- `check:bundle` signs in as a seeded viewer and portal-dev and checks the 403s
  on pages and the BFF on every gate run.
- Not built: per-API or per-environment scoping of a role, custom roles, account
  deletion, password reset by an admin.
