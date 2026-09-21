# Upstream (g2way) journal

g2way is the driver for this project. Every time a watched area of it changes,
`npm run sync:g2way` regenerates `contracts/` and appends an entry below.

Entries are append-only history — never rewrite one. Tick the `TODO` boxes as the
dashboard catches up; those are the open work items this journal exists to track.

Watched areas are defined in `contracts/watch.json`; the recorded fingerprints live
in `contracts/g2way.lock.json`. Run `npm run check:g2way` to see whether we are behind.

## 2026-09-10 — g2way (none) → 9f0b811

Initial lock against g2way `9f0b81166d0903f09e265acc8769b33a589e7173`. All 12 watched areas recorded; no drift to report yet.
