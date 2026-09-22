# ADR-0006: The audit log

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0003, ADR-0004, ADR-0005

## Context

CLAUDE.md requires every mutating action to be audited with the actor,
before/after state and the resulting gateway call. ADR-0003 created an
`audit_log` table but nothing wrote to it. The dashboard is the only place this
can happen: the gateway has one shared secret and no idea who is calling it.
Several questions needed an answer that the earlier ADRs don't give: what counts
as an audited action, where before/after come from, what happens when the audit
write itself fails, and how to keep secrets out of a table that admins can
browse.

## Decisions

1. **What is audited.**
   - Every non-GET call through the BFF proxy that gets past the 404/405
     allowlist. Reads are not audited.
   - User management: create, role change, disable and enable.
   - First-run bootstrap (`auth.bootstrap`), sign-in (success, failure and
     disabled account) and sign-out.

   Requests the proxy rejects as malformed (400 bad path or unknown environment,
   404, 405, 500 broken registry) are not audited: they name no resource and
   reach nothing. **Refusals are audited** with outcome `denied`: a role without
   the permission, an unmapped operation, a cross-site write, or a
   user-management refusal from ADR-0005 §4/§5.

   Actions are `<resource>.<verb>`: `api|policy|key.create|update|delete`
   (derived from the collection and the method), `gateway.reload`,
   `graphql.sync`, `user.create|role_change|disable|enable`,
   `auth.bootstrap|sign_in|sign_out`. An unknown future operation falls back to
   `"<METHOD> <spec path>"`, so a new upstream endpoint is audited before anyone
   names it. A `PUT` that creates an item is still `*.update`, and its empty
   `before` shows that it was a creation.

2. **Row shape.** Besides ADR-0003's columns the row snapshots `actor_role`, the
   gateway `environment`, the redacted `request` body (what was asked for), an
   `outcome` (`pending | success | failure | denied`, not null), `error` (the
   refusal, or the gateway's `{"error"}` message verbatim) and `note` (caveats
   about the snapshots). Migrations `0001_audit_outcomes` are hand-edited: SQLite
   cannot `ADD` a `NOT NULL` column without a default, so it rebuilds the table,
   and Postgres backfills then drops a temporary default. Any existing rows (no
   release wrote any) are kept as `success`. A test replays both migrations over
   a pre-existing row.

3. **Before and after for gateway writes come from the gateway itself.**
   - `before`: for an item path (`/g2/{apis,policies,keys}/{id}`), a `GET` of the
     same item with the same `hashed` flag and org scoping, made just before the
     write. A 404 means there was nothing (`null`). Any other failure is also
     `null`, with a note, and the write still goes ahead: a snapshot must never
     block the change it describes.
   - `after`: on success, a `GET` of the item (for a create, the id the gateway
     returned: `id`, or `key_hash` read with `hashed=true`). A delete's `after`
     is `null`. Reload and GraphQL sync have no item, so their `after` is the
     gateway's response body. If the re-read fails, a create falls back to the
     response body and every case gets a note.
   - We re-read instead of trusting the request body because the gateway
     normalises and defaults what it stores, and the audit should show what is
     actually stored. The request body is kept separately in `request`.
     Writes are staged until `POST /g2/reload` (CLAUDE.md), so `after` is the
     stored definition, not necessarily what is live.

4. **Redaction happens in the data layer, on the way in.** `auditValues()`
   (`src/lib/db/audit.ts`) runs `before`, `after` and `request` through
   `redactSnapshot()` (`src/lib/audit/redact.ts`), so no caller can forget to.
   A string or numeric value is replaced by `[redacted]` when its property name
   matches `secret|passw|token|authorization|cookie|api[-_]?key|private[-_]?key|signature|credential|session[-_]?id`,
   at any depth. That covers `hmac.secret`, `basic_auth.password_hash`, JWT
   `secret` and credential-bearing header values in header maps. It errs toward
   hiding (a cookie _name_ is hidden too) and leaves booleans alone. When a
   secret differs between before and after, `after` shows `[redacted: changed]`,
   so the diff says that it rotated and never shows the value. Over and above
   the name rule:
   - **Raw API keys never reach the table.** A key in the path
     (`/g2/keys/{raw}`) is recorded by its SHA-256 hash, g2way's `key_hash`, in
     both `target` and `gateway_path`, with a note. `POST /g2/keys`'s raw `key`
     is replaced before the body is used, and `after` is the stored session
     read back by hash.
   - The admin secret is never part of any recorded value: headers are not
     recorded at all.
   - User snapshots are id, email, name, role, disabled and created time. They
     never include the password hash.
   - Snapshots larger than 256 KiB as JSON are dropped with a note, and text
     fields are clipped at 2000 characters.

   Tests prove that the raw key, the HMAC secret and the admin secret are absent
   from every stored row across a key's create, update and delete, and that no
   password hash reaches a user row.

5. **Failure policy: gateway writes and account changes fail closed; sign-in
   events are best effort.**
   - BFF writes are audited **write-ahead**. The `pending` row (actor, action,
     target, before, request, intended call) is written _before_ the gateway is
     called. If that insert fails, the write is not sent and the browser gets
     503 `{"error": "audit log unavailable: …"}`, with the database error only in
     the server log. After the call the row is rewritten with the outcome. If that
     update fails, the gateway's response is still returned (the change has
     happened), the failure is logged with `[audit] FAILED` and the row id, and
     the row stays `pending`. The page labels such a row as incomplete, with a
     prompt to check the gateway.
   - User-management writes and the bootstrap insert their row **inside the same
     transaction** as the change (`src/lib/db/users.ts`), so a change never
     commits without its row. Refusals are recorded in that transaction too.
   - Denied BFF writes, sign-in and sign-out are recorded best effort: a failure
     is logged loudly and does not block. Refusing every sign-in while the table
     is unwritable would lock out the owners who need to fix it. A denial changed
     nothing, so losing its row loses no record of a change.

6. **Sign-in failures don't become an account directory.** A failed sign-in has
   no actor. Its target is the attempted address, normalised, and only if it
   looks like an email address (`[not an email address]` otherwise, because
   people paste passwords into the email field). An unknown email and a wrong
   password produce identical rows (`failure`, "invalid email or password"). A
   disabled account is `denied`, which is only known after the password was
   proven right (ADR-0004 §7). No password or hash is ever recorded.

7. **Reading the log.** `/audit` and `/audit/[id]` require `audit:read` (admin
   and owner, ADR-0005). They are Server Components. The list is filtered by a
   plain GET form: actor email contains, action prefix, target contains,
   outcome, and a UTC date range with `to` inclusive. It is paged 50 at a time
   by offset, newest first, and never loads the snapshots. The detail page shows
   the metadata, a path-level structural diff (`src/lib/audit/diff.ts`, hand
   rolled with no dependency) and the raw before/after/request JSON. Times are
   shown in UTC so server and client render the same text. Filters use `LIKE`
   (SQLite) or `ILIKE` (Postgres), with wildcards escaped.

## Consequences

- Every gateway write costs up to two extra gateway GETs and two database writes.
  That is acceptable for an admin console. Bulk operations (M4) may want a batched
  form later.
- If the database is unwritable, gateway writes are refused with 503 while reads
  keep working. That is deliberate.
- ~~Rows written in the same millisecond have no defined order among themselves.~~
  _Amended 2026-09-23:_ ids are now UUIDv7 from `monotonicUuid()`
  (`src/lib/db/schema/shared.ts`). They are still app-generated text UUIDs
  (ADR-0003 §2), so no migration was needed, but they strictly increase within
  one server process. The list's `ORDER BY created_at DESC, id DESC` is
  therefore insertion order for one server's rows, even within a millisecond.
  Rows written in the same millisecond by different replicas still have no
  defined order. There is no sequence column.
- M3's config history and rollback can build on the same before/after snapshots,
  but will want its own table: audit rows are redacted, so they cannot restore a
  secret.
- _Added 2026-09-23 (M3):_ reload-required state is **derived from this log**,
  not stored separately (`src/lib/db/pending.ts`). A staged change is a
  successful `api.*`/`policy.*` row for an environment that comes after that
  environment's last successful `gateway.reload` row, ordered by
  `(created_at, id)`. The log already records both atomically with the
  gateway calls, so there is no second record to drift. The costs:
  - A reload made outside the dashboard is invisible, and the UI says so.
  - Retention (M11) must never prune a write row newer than its environment's
    last reload, or staged changes would silently disappear.
- Not built: retention or pruning, export, per-row integrity (hash chaining),
  and client IP or user agent.
