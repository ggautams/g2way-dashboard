# ADR-0007: Org scoping of records, sessions and gateway calls

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0003 §3, ADR-0004 §3, ADR-0006

## Context

CLAUDE.md requires `org_id` on every record and request, always `"default"`
today, never hardcoded. Up to now that was a convention. The schema carried the
column (ADR-0003 §3), the data layer took an `orgId` argument, sessions carried
an org claim (ADR-0004 §3), and the BFF set `?org_id=` on the operations the
spec declares it for. Nothing proved that one org's rows are out of another's
reach. And one gap was real: g2way's write handlers (`crates/g2-admin/src/resources.rs`
`create`/`put`, `keys.rs` `create_key`/`put_key`) file a record under the
**body's** `org_id`, and serde fills a missing one with g2way's `DEFAULT_ORG_ID`.
The query parameter plays no part in that. So with `G2_ORG_ID=acme`, a
dashboard write would land in the gateway's default org, and a body naming
some other org would be written straight into it.

## Decisions

1. **One org per deployment, from config.** `getOrgId()` (`src/lib/g2/environments.ts`)
   reads `G2_ORG_ID`, and the fallback to g2way's default is the only `"default"`
   org literal in `src/`. `src/lib/org-literal.test.ts` enforces that. It flags
   the literal when it is assigned to or compared with an org field, used as an
   org or `G2_ORG_ID` fallback, put in an `org_id` query, or passed to any
   function declared with an `orgId` parameter. Other `"default"` strings are
   ignored. The org is never taken from the browser, a form or a token.

2. **Dashboard records: every read, write and lock is filtered by org.** Every
   table's `org_id` is non-null with no default, checked on both dialects by
   `schema.test.ts`. Every function in `src/lib/db/` takes the org and puts it
   in the `WHERE` of every select, update and returning clause, on every insert,
   and in the advisory-lock keys. `src/lib/db/tenancy.test.ts` seeds org A and
   proves from org B, on SQLite and PGlite, that org A's rows cannot be listed,
   fetched by id or email, updated, re-bootstrapped, signed into, or
   audit-completed. It also proves that an org A actor id carries no authority
   in org B, and that org B's owners neither count toward nor can reach org A's
   last active owner. A refusal is audited in the org where it was attempted.
   Emails are unique per org, not globally.

3. **Sessions are bound to the org they were issued for.** The JWT is stamped
   with `getOrgId()` at sign-in. `getCurrentUser()` treats a token for another
   org, or one with no org claim, as signed out. It then loads the account by id
   _and_ org, so even a matching claim cannot name another org's user. Pages,
   server actions and the BFF all resolve the caller through `getCurrentUser()`,
   and `src/lib/auth/session.test.ts` drives the real function to show a foreign
   token is refused at each: redirect to `/login`, "session has ended", and 401.
   Changing `G2_ORG_ID` therefore signs everyone out and shows the new org's
   first-run setup.

4. **Gateway queries: the configured org, always.** Unchanged from M1. Every
   operation declaring `?org_id=` gets the configured org, overwriting any the
   browser sent (`withOrgId`).

5. **Gateway write bodies: inject if missing, refuse if different.** The body
   of every operation whose JSON request schema has an `org_id` property is
   scoped by `scopeBody()` (`src/lib/g2/org-scope.ts`). The set is derived from
   the spec: `POST`/`PUT` of APIs, policies and keys. It applies in the BFF
   proxy and in the server-side typed client.
   - **No `org_id`**: the configured org is spliced in as the first member. The
     rest of the body is sent byte for byte, never re-serialised, so large
     integers and key order survive.
   - **The configured org**: the body is sent unchanged.
   - **Any other value** (another org, the wrong case, `null`, a number): the
     write is refused. The BFF answers 403 `forbidden: cross-org write refused: …`
     and audits it as `denied` (ADR-0006 §1). The typed client throws
     `OrgScopeError`. Nothing reaches the gateway.
   - **`org_id` twice** (including a `\u`-escaped spelling): refused the same
     way. `JSON.parse` keeps the last one and a Rust parser might keep another,
     so the dashboard does not guess which one the gateway will honour.
   - **Not a JSON object** (or not UTF-8): 400 `invalid request body: …`, not
     sent. Its org cannot be checked. Like the proxy's other malformed-request
     refusals, it is not audited.

   We refuse a mismatch rather than overwrite it, although the query parameter
   is overwritten. A query `org_id` only selects where a read or delete looks,
   and the dashboard owns that choice. A body that names an org says where the
   caller _means_ to write. If that is another tenant, it is a bug or an attack.
   Silently re-homing it would store a record the caller did not ask for, in an
   org they did not name, and hide the fact. The gateway applies the same rule
   when a body id does not match the path id.

6. **Pod-wide operations stay unscoped.** `/g2/node`, `/g2/stats`, `/g2/reload`,
   `/g2/graphql/sync`, `/g2/version` and `/g2/health` take no org upstream. A
   reload reloads every org, and `/g2/node` lists every loaded API with its own
   `org_id`. In single-org mode that is all the dashboard's. When g2way grows
   real multi-org, the gateway page must filter the route table by `org_id`,
   and reload must become a platform-level permission. Recorded here so that
   work starts from a known gap, not a surprise.

## Consequences

- A `sync:g2way` that adds a write whose body schema carries `org_id` is scoped
  automatically. One that changes where upstream reads the org shows up as
  `admin-api` drift, whose `onChange` note in `contracts/watch.json` now says to
  re-check this.
- M3's editors must either leave `org_id` out of what they send or send the
  configured org. Round-tripping a gateway `GET` does the latter.
- Multi-org is still one org per deployment. Serving several orgs from one
  dashboard would move the org from config into the session (chosen at sign-in)
  and needs its own ADR. Every data-layer and gateway boundary already takes the
  org as an argument, so that change stays at the call sites.
