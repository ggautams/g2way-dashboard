# ADR-0004: Dashboard sign-in and first-run bootstrap

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0001, ADR-0003

## Context

Until M2 anyone who could reach the dashboard held full gateway admin through
the BFF proxy. The dashboard needs its own accounts (the gateway has none, and
must not hold any: ADR-0001 §3), a way to create the first one on a fresh
install, and an enforcement point that every page and the BFF actually pass
through. Roles are stored now but enforced by the next task.

## Decisions

1. **Auth.js v5 (`next-auth@5.0.0-beta.32`, pinned exactly) with one Credentials
   provider (email + password) and JWT sessions.** v5 is the line that supports
   the App Router and Next 16 (its peer range includes `^16`); it has shipped as
   `beta` for a long time, so the version is pinned and upgrades are deliberate.
   Credentials sign-in requires the JWT strategy. The token is an encrypted
   cookie keyed by `AUTH_SECRET`, lives 12 hours, and carries only the user id
   (`sub`) and the org it was issued for. Config lives in `src/auth.ts`
   (server-only). `AUTH_SECRET`, `AUTH_URL` and `AUTH_TRUST_HOST` are documented
   in `.env.example`; `trustHost` is left to the environment, not hard-coded.

2. **Passwords are hashed with Node's `crypto.scrypt`**, no native dependency:
   N=2^15, r=8, p=1, 16-byte random salt, 32-byte key, compared with
   `timingSafeEqual`. The stored string encodes its own parameters
   (`scrypt$N$r$p$salt$key`), so the cost can rise later without a migration;
   hashes with absurd parameters are rejected rather than computed. Input is
   NFKC-normalised. An unknown email still costs one scrypt run, so timing does
   not reveal which emails have accounts. Minimum length is 12 characters.

3. **The database is re-read on every request.** `getCurrentUser()`
   (`src/lib/auth/session.ts`) verifies the JWT, then loads the user by id and org
   and treats a missing or disabled account, or a token issued for another org, as
   signed out. This is one primary-key lookup per request, memoised with React
   `cache` so a layout and page share it. We chose it over a "cheap" token-only
   check because a JWT cannot be revoked: disabling a user, and next task's role
   changes, must take effect on the next request, not at token expiry. The
   account (and later its role) always comes from the database, never from
   claims in the token. If this ever costs too much, add a short per-process
   cache with explicit invalidation, not longer-lived claims.

4. **Enforcement is server-side at each entry point; there is no `proxy.ts`.**
   - Signed-in pages live in the `src/app/(app)` route group. Its layout calls
     `requireUser()` to render the shell, and **every page calls it again**,
     because layouts are not re-rendered on client navigations, so a
     layout-only check would miss a user disabled mid-session.
     `src/app/(app)/pages.test.ts` fails if a page omits the call.
   - The BFF route wraps every method in `withUser` (`src/lib/auth/api.ts`):
     no session means 401 in the gateway's `{"error": "..."}` envelope, checked
     before anything else, including the proxy allowlist.
   - `/login` and `/setup` live in `src/app/(auth)`, without the shell (so no
     gateway probes for signed-out visitors).

   A Next 16 `proxy.ts` would only have duplicated the no-cookie case. It
   cannot be the enforcement point (it runs apart from the page's own render),
   and loading the database driver into it buys nothing the pages don't already
   do. It can be added later as a redirect convenience if wanted.

5. **First-run bootstrap is race-safe in the database.** While the org has no
   users, every page redirects to `/setup`; once any user exists, `/setup`
   redirects to `/login`. The page check is advisory: `createFirstOwner()`
   (`src/lib/db/users.ts`) re-checks emptiness inside a transaction that holds
   a write lock from its start (SQLite `BEGIN IMMEDIATE`; Postgres
   `pg_advisory_xact_lock` keyed on the org). Read-committed alone would let two
   submits with different emails both succeed. Of two racing submits exactly
   one becomes owner and the other is sent to `/login` (tested, including over
   two separate SQLite connections).

6. **Data access goes through `src/lib/db/users.ts`**, the first module over
   ADR-0003's union. It accepts a `DataHandle` (the union, with the Postgres
   side typed as any `PgDatabase`, so PGlite handles work in tests) and narrows
   on `dialect` once per function. Emails are trimmed and lower-cased on write
   and on lookup. Later tables (audit, history) follow the same pattern.

7. **Forms are server actions handed to client components as props.** The
   login and setup forms (`src/components/auth/`) are client components for
   `useActionState`, but the page passes the action in, so no client module
   imports the auth layer (`client-boundary.test.ts`). Next.js checks each
   action's `Origin`. Failed sign-ins say "Invalid email or password"; "This
   account is disabled" is shown only after the password is proven correct.

8. **Failed sign-ins are throttled in the database** (_added 2026-09-23_,
   `src/lib/auth/throttle.ts`). Each wrong password writes a `login_failures`
   row against the email tried and against the client address; once either
   has too many in a sliding 15-minute window (10 per email, 30 per client),
   attempts are refused before any password work and audited as `denied`. A
   refused attempt is not counted, so a lockout never extends itself; unknown
   emails count like real ones; a right password clears only its email's
   count. The client address is the last `X-Forwarded-For` entry, which
   Next.js fills from the socket and a trusted proxy appends, so it is
   forgeable only when the dashboard is exposed directly; the per-email limit
   is the guard that holds either way. Database rather than memory, so limits
   survive restarts and hold across replicas. There is no permanent lockout:
   an attacker who knows an address can keep that account throttled while
   they keep failing, and the audit log is where an owner sees it.

## Consequences

- `scripts/check-client-bundle.mjs` has to sign in to scan anything real. It
  checks the signed-out redirects and the BFF 401, seeds an owner into its
  throwaway database, signs in through Auth.js's credentials endpoint, and
  requires every page in `PAGES` to answer 200 with the user's shell before
  scanning. `AUTH_SECRET` is a canary alongside the gateway secrets.
- Losing `AUTH_SECRET` or rotating it signs everyone out. That is the only
  session-revocation lever besides disabling users.
- Not built yet: password change and reset. (Sign-in and bootstrap auditing
  landed with ADR-0006; sign-in throttling is §8.)
