# ADR-0016: Saved analytics views

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0003, ADR-0005, ADR-0006, ADR-0007, ADR-0013, ADR-0015

## Context

M6 asks for saved views on `/analytics`: a name for a selection that people
come back to, such as "checkout 5xx, last 24 h" or "the 2026-09-01 incident".
Everything a view shows is already in its URL. That covers the source
(ADR-0015), a fixed range or a custom window (ADR-0013 §7), the API, one focus
and the breakdown (`drillParams` in `src/lib/analytics/drill.ts`). So saving a
view means saving that URL under a name. Four questions are left:

- where views live, and how they are scoped;
- what exactly is stored, given that the page re-validates every parameter;
- whether a view belongs to one person or to the team, and who may share;
- how the writes are audited.

## Decisions

1. **Views live in the dashboard database, in `saved_views`** (migration
   `0009_saved_views`, both dialects). Each row has `org_id` (from config,
   ADR-0007), `environment` (the one selected when the view was saved),
   `owner_id` and `owner_email` (a snapshot, like the audit actor), `name`,
   `shared`, `query`, `created_at` and `updated_at`. The gateway knows
   nothing about them (ADR-0001 §3). A view is listed only in its own
   environment. API ids and key hashes differ between environments, so
   carrying a view to another environment would mostly show nothing.

2. **What is stored is the canonical query string.** The save action does not
   trust the submitted string. It parses it the way the page does
   (`parseDrill`, the fixed range ids, `readCustomWindow`) and writes it back
   with `drillParams`, in a fixed order. So the stored query always contains
   `source` when it is not the default, and either `range=<id>` or
   `from=`/`to=`:
   - `range=24h` is **relative**. Opening the view shows the last 24 hours
     at that moment.
   - `from=…&to=…` is **absolute**. Opening the view always shows that
     window.

   Parameters that parse but no longer apply are not an error at save time.
   Examples are a Prometheus source that has since been removed, or a key
   focus opened by a role without `keys:read`. On open, the page notes each
   one, as it does for a hand-typed URL. Opening a view is only following its
   link, so nothing else is needed.

3. **Personal by default, shared on request, sharing gated by a new
   `analytics:share` permission** (editor, admin, owner):
   - A **personal** view is visible only to its owner. Anyone with
     `gateway:read` (the page's own permission) may create one and delete
     their own. Nobody else can see or delete it, admins included: it is
     their bookmark, not team configuration. Accounts are disabled, never
     deleted (ADR-0005), so the rows stay behind with their owner.
   - A **shared** view is listed for everyone with `gateway:read` in that org
     and environment. Creating one, or deleting any shared view, needs
     `analytics:share`. A shared view belongs to the team, like an API
     definition that any editor may change, so it is not tied to whoever
     made it. It stays if its creator later loses the permission.
   - We chose a new permission over reusing one. `analytics:inspect` is about
     seeing individual requests, and `apis:write` is about the gateway.
     Sharing changes only what colleagues see in a list. It sits with the
     editors because a viewer is read-only everywhere else.

4. **Create and delete only; no rename or edit.** A name is unique per owner
   and environment (`saved_views_owner_name_unique`), and a clash is refused
   with the reason. Changing a view means saving it again under a new name
   and deleting the old one. Each person may keep at most 50 views per
   environment (`MAX_VIEWS_PER_OWNER`). The cap is counted inside the write
   transaction, and it bounds the list the page renders.

5. **Every write is audited in its own transaction** (ADR-0006 §5, like user
   management and key metadata). The actions are `analytics.view.create`
   and `analytics.view.delete`. `before`/`after` snapshot `name`, `shared`,
   `query` and `owner`, and `target` is the view id. There is no gateway call
   and nothing is staged, and the row says so. Refusals are recorded best
   effort with outcome `denied`: sharing without `analytics:share`, or
   deleting a view the actor may not delete (someone else's personal view, or
   one that does not exist in this org and environment).

6. **UI: a "Saved views" section on `/analytics`.** It shows shared views
   first, then the user's own. Each is a link with its range described
   (relative or absolute) and its source. Below the list is a form that
   saves the view on screen, with a "Share with the team" checkbox shown
   only to roles with `analytics:share`. The list is server-rendered. The
   save form and the delete buttons are small client components, only to
   show each action's result. They receive the server actions as props and
   import nothing server-side.

## Consequences

- One more table, holding no secret: a query string can name an API id or a
  key hash, both identifiers (ADR-0010).
- ADR-0005's matrix gains `analytics:share`.
- Views break quietly when what they name goes away (a deleted API, an
  environment without Prometheus). The page's notes say what was ignored.
- Not built: renaming, per-user ordering or pinning, sharing across
  environments, admin cleanup of a disabled account's personal views, and
  views on `/analytics/live`.
