# ADR-0008: Config version history and rollback

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0003, ADR-0006

## Context

M3 promises version history with rollback for API definitions. The gateway
keeps only the current definition, so history has to live in the dashboard's
database (ADR-0001 §3).

The audit log (ADR-0006) already stores a before and after snapshot of every
write, but it cannot serve as history. Its snapshots are redacted on the way in.
A JWT secret, a basic-auth hash or an HMAC key reads as `[redacted]`, so a
definition rebuilt from the audit log would not work. ADR-0006 said as much:
history "will want its own table".

## Decisions

1. **A `config_versions` table**, one row per version of an API definition or
   policy, per org and environment. It holds the resource id, the definition
   (JSON, `null` for a delete), what produced it (`create`, `update`,
   `delete`, or `baseline`), the actor, and the id of the audit row for the
   write. It is indexed by resource and time.

2. **Definitions are stored unredacted.** That is the point: a rollback must
   restore exactly what was there. The table is therefore as sensitive as the
   gateway's own storage. It holds the same secrets, and like the audit table it
   is never exposed except through the pages that need it.

3. **The BFF writes it, after the gateway accepts a write.**
   - `auditedWrite` already reads the resource before and after every write for
     the audit row, so it hands those raw states to `AuditSink.version`.
   - This is best effort: the write has already happened, so a failure to keep
     the version is logged and does not fail the request. This differs from the
     audit row, which fails closed _before_ the write.
   - If the after-read fails, the request body the gateway accepted is stored
     instead.
   - Keys are not versioned: they are credentials, not configuration.

4. **A baseline before the first dashboard write.** The first time a resource
   is written through the dashboard, the version it replaced is kept as
   `baseline` if it existed. A definition created by the CLI or by GitOps can
   then be rolled back past its first dashboard edit.

5. **Rollback is an ordinary save.** The designer's History tab loads a chosen
   version into the draft, and saving it runs the same diff preview, BFF PUT,
   audit row, new version row and reload-required state as any edit. There is
   no separate rollback endpoint and no rollback action to audit differently.

6. **Who sees history is who sees the definition.** The page passes versions to
   any role with `apis:read`, which is the same audience that
   `GET /g2/apis/{id}` through the BFF already shows full definitions to. If the
   BFF ever redacts secrets for read-only roles, history must redact with it.
   That is a roadmap item.
   _Amended 2026-09-23 (ADR-0010):_ it does now. `toHistoryEntry` masks a
   version's secrets for a role without the kind's write permission, exactly
   as the BFF and the page loaders do. The table itself stays unredacted.

## Consequences

- Only writes made through the dashboard are versioned. Changes made elsewhere
  show up as the baseline, or as the `before` of the next dashboard write, but
  not as versions of their own.
- A deleted API no longer has a definition page, so its history is reachable
  only through the database until restore-from-history exists (M11's config
  backup and restore).
- The table grows without bound. Retention belongs with M11's audit retention
  work.
- Policies are versioned from now on. Their history UI comes with M4's policy
  editor.
