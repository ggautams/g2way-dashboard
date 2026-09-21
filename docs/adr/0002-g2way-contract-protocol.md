# ADR-0002: The g2way contract and drift protocol

Date: 2026-09-10 · Status: accepted

## Context

g2way is the driver for this project: its admin API, its domain models and its
runtime behaviour define what this dashboard can do. Two problems follow from
that, and they pull in opposite directions.

The first is cost. g2way is a large Rust workspace. A session that answers
"what fields does an API definition have?" by grepping it burns an enormous
amount of context to recover something the gateway already publishes as a
machine-readable document.

The second is staleness. Anything cheap enough to be worth caching here — a
generated type, a vendored doc, a note in a map file — is by definition a copy,
and copies drift. A dashboard silently built against a six-month-old
`ApiDefinition` is worse than one that had to go read the source.

The gateway's own `crates/g2-admin/src/openapi.rs` states the intent: "a
dashboard or client generator reads one URL and gets the whole admin surface."

## Decisions

1. **Derive, don't describe.** Everything mechanically derivable from g2way is
   generated into `contracts/` and committed: the OpenAPI document, the
   TypeScript types, and a verbatim copy of the gateway's docs and ADRs. None of
   it is hand-edited. Because utoipa carries the Rust rustdoc into the schema
   descriptions, the generated types arrive documented — which is where most of
   the saving comes from.

2. **A fixed lookup order, stated in `CLAUDE.md`.** Generated types, then the
   OpenAPI document, then the curated map, then the vendored docs, and only then
   a single named upstream file. Never a directory sweep. `docs/g2way-map.md`
   exists to make step three land: it maps topics to exact upstream paths and
   records the behavioural invariants the OpenAPI document cannot express —
   reload semantics, hash-only key listing, per-pod stats, the protected-by-default
   auth rule.

3. **Fingerprint upstream areas with git object IDs.** `git rev-parse HEAD:<path>`
   yields the tree OID of a directory or blob OID of a file, which changes if and
   only if that path's content changed. Watched areas are defined in
   `contracts/watch.json` and their OIDs recorded in `contracts/g2way.lock.json`.
   This reads no files, costs one git call per path, and — crucially — means
   unrelated upstream commits produce no churn here.

4. **An area maps upstream paths to dashboard surfaces, not just to files.** Each
   entry carries `surfaces` and an `onChange` instruction, so a drift report says
   what to _do_, not merely that something moved. This is the part that makes the
   mechanism useful rather than noisy.

5. **The note is a git commit plus an append-only journal.** `npm run sync:g2way`
   regenerates the contracts, appends a dated entry to `UPSTREAM.md` naming what
   moved upstream (quoting g2way's own commit subjects, which are unusually
   descriptive) and which surfaces it affects, then commits with a
   `G2way-Upstream: <sha>` trailer. Entries are never rewritten; the `TODO`
   checkboxes inside them are the open work items and get ticked as the dashboard
   catches up.

6. **The check fails builds; a missing gateway does not.** `npm run check:g2way`
   runs in `make check` and the pre-commit hook and exits non-zero on drift. But a
   missing g2way checkout exits zero with a message — this repo must still build
   on a machine or in CI that has no gateway beside it. A _dirty_ upstream tree
   only warns, because g2way is often mid-session; `sync` refuses outright, since
   a lock recorded against uncommitted state names OIDs nobody can reproduce.

## Consequences

- Regenerating contracts requires a g2way checkout with a working Rust toolchain.
  That cost is paid at sync time by one person, not on every install: the
  generated artifacts are committed, so a normal `npm install && make check`
  needs neither.
- This protocol needed one upstream change: the OpenAPI document was only
  renderable inside `g2-admin`. g2way now has `make openapi` writing a committed
  `docs/api/openapi.json`, and diffs it in its own `check` gate so it cannot go
  stale. Landed as `feat(admin): dumpable OpenAPI spec`.
- `watch.json` is the mechanism's weak point: it only covers what someone thought
  to list. When you start depending on a new part of g2way, add an area. The
  checker's `--verbose` mode reports upstream crates no area covers as a hint.
- Vendoring the gateway's docs duplicates ~216 KB. It buys in-repo reading for
  Claude and runtime rendering for the explain panels in a container that has no
  g2way checkout; the `docs` watch area keeps the copy honest.
