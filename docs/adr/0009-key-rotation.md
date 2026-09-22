# ADR-0009: Key rotation as a BFF orchestration

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0005, ADR-0006, ADR-0007

## Context

M4 promises key rotation. g2way has no rotate endpoint and no batch or
transaction endpoint. A key's identity is its raw value, which g2way generates
and returns exactly once from `POST /g2/keys`, and stores only as a SHA-256 hash.
So rotating means making a new key with the old key's session, then removing the
old key. That takes three admin calls, and the gateway cannot make them atomic.

## Decisions

1. **The BFF orchestrates it, server-side**, at `POST /api/g2/keys/{hash}/rotate`
   (`src/app/api/g2/keys/[hash]/rotate/route.ts` → `src/lib/g2/rotate-key.ts`).
   The browser makes one call. The raw key comes back in that call's answer,
   so it never passes through anything but the BFF's response.
   - The route is a literal path under `/api/g2`. Every other path still goes
     to the `[...path]` proxy.
   - It shadows no gateway endpoint today. A test fails if the spec gains a
     `/rotate` path, and that is the signal to proxy the native endpoint instead
     (`UPSTREAM.md`).

2. **The three calls go through `proxyToGateway`**: the same permission check,
   org scoping, admin secret and audit as a browser call. The calls are:
   1. `GET /g2/keys/{old}?hashed=true` reads the session.
   2. `POST /g2/keys` with that session, unchanged, creates the new key.
   3. `DELETE /g2/keys/{old}?hashed=true` removes the old key.

   Each write gets its own `key.create` / `key.delete` audit row, so rotation
   adds no second audit path.
   - All three calls are pinned to the environment the request resolved to, by
     header.
   - The CSRF check runs once, on the browser's request. The inner calls carry
     no `Origin`.

3. **One `key.rotate` audit row links them.**
   - It needs `keys:write`. A refusal is recorded as `denied`.
   - It is written `pending` before any call and fails closed (503, nothing sent),
     like every audited write.
   - It is completed with before `{key_hash: old, session}` and after
     `{key_hash: new, session}`. The data layer redacts both.
   - Its `gateway` field is the last call made.
   - No raw key ever enters a row or a log. A test checks this against SQLite.

4. **Failure order is chosen so the safe outcome is the common one.**
   - If the read or the create fails, the old key is untouched. The answer is
     the gateway's own status and `{"error"}`.
   - If the create succeeds and the delete fails, both keys work. The answer is
     still 201, because the new raw key must reach its user once:
     `{"outcome": "partial", key, key_hash, old_hash, error}`.
   - The UI says plainly that both keys exist and names both hashes. The audit
     row is a `failure` with `both keys now exist: created <new>, but deleting
<old> failed: …`.
   - We create before deleting because the reverse order could lose the key
     outright if the create then failed.

5. **Keys stay unversioned** (ADR-0008 §3). The session is copied as stored,
   `hmac` and `basic_auth` included, so the new key behaves exactly like the
   old one.

6. **The raw key is shown once and then dropped.** The create and rotate UIs
   hold it in React state only while the one-time dialog is open. The dialog
   cannot be dismissed by accident, and closing it clears that state and
   navigates by hash. The key is never put in a URL, stored or logged. A static
   test (`src/lib/keys/raw-key-guard.test.ts`) checks the modules that hold it.

7. **Addendum (2026-09-23): key inventory lives in the dashboard.** g2way lists
   keys by hash only and has no field for a human label, so the label, owner
   and notes live in the dashboard's `key_metadata` table (migration
   `0005_key_metadata`), unique on `(org_id, environment, key_hash)`. Never
   the raw key.
   - **Owner is free text**, not a user reference. A key's owner is usually a
     consumer (a team, a customer, a service), not a dashboard operator, and a
     foreign key would dangle once that account is deleted. `created_by` is the
     writer's email, snapshotted like the audit actor.
   - **Create**: the new-key form takes the three fields. After the gateway
     answers, the browser calls a server action with the returned `key_hash`.
     The raw key never leaves the one-time dialog. That action (also the key
     view's editor) needs `keys:write`, confirms the hash with
     `GET /g2/keys/{hash}?hashed=true` and upserts. A failure does not undo
     the key: the dialog says so, and the key view can retry.
   - **Rotate**: after the create and before the delete, the orchestration
     _copies_ the row to the new hash (`key.metadata.rekey`). The delete then
     drops the old row, so a full rotation is a move and a partial one leaves
     both keys described. The delete happens only once the copy is done. A
     failed copy is a note on the `key.rotate` row and never fails the
     rotation.
   - **Hard delete**: after a successful `DELETE /g2/keys/{key}` the proxy
     deletes the row. There is no tombstone. The `key.metadata.delete` audit
     row keeps what was removed as `before`, so the inventory of a deleted key
     can still be read there. A soft revoke (`active: false`) leaves it alone.
   - Every change is audited in the same transaction as the row
     (`key.metadata.update` / `.rekey` / `.delete`, before and after, ADR-0006).
     None of them calls the gateway, so none needs a reload. None is in
     `STAGED_ACTIONS`.
   - A key deleted outside the dashboard leaves an orphan row. Nothing lists it,
     because rows are only read for hashes the gateway returns.
     _(2026-09-23)_ `/keys` now lists such rows to `keys:write` roles and
     prunes them after a review step (`lib/g2/key-orphans.ts`), each audited
     as `key.metadata.delete` with the row as `before`. A row counts as an
     orphan only when `GET /g2/keys` succeeded and does not list its hash; the
     prune re-reads that list itself, and a failed read prunes nothing.

## Consequences

- Rotation is not atomic, and clients using the old key fail as soon as it is
  deleted. There is no grace period.
- A native `POST /g2/keys/{key}/rotate` is requested upstream (`UPSTREAM.md`).
  When it lands, this orchestration is replaced by the proxy.
- A rotation writes three audit rows. The `key.rotate` row is the one to read.
