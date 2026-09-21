#!/usr/bin/env node
// Read-only upstream drift detector. Runs in `make check` and the pre-commit
// hook, so it must be fast, must never write, and must not fail for reasons
// outside this repo's control (a missing or mid-session g2way checkout).
//
// Exit codes: 0 = in sync (or nothing to compare against), 1 = drift.

import {
  SHORT,
  commitsSince,
  computeDrift,
  headSha,
  isDirty,
  readLock,
  readWatch,
  resolveG2wayRepo,
  uncoveredCrates,
} from './g2way-lib.mjs';

const args = process.argv.slice(2);
const repoFlag = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : null;
const verbose = args.includes('--verbose');

const watch = readWatch();
const g2way = resolveG2wayRepo(watch, repoFlag);

// A missing checkout is not a failure: the dashboard still has to build on a
// machine (or in CI) that has no g2way beside it.
if (!g2way.exists) {
  console.log(`g2way repo not found at ${g2way.raw} — skipping drift check.`);
  console.log('Set G2WAY_REPO to point at a checkout if you want this enforced.');
  process.exit(0);
}

const lock = readLock();
if (!lock) {
  console.log('No contracts/g2way.lock.json yet — run `npm run sync:g2way` to record one.');
  process.exit(0);
}

const head = headSha(g2way.path);
const drift = computeDrift(g2way.path, watch, lock);
const changed = drift.filter((d) => d.drifted);
const unlocked = drift.filter((d) => d.unlocked);
const missing = drift.filter((d) => d.missing.length > 0);

// g2way is often mid-session; warn, never fail.
if (isDirty(g2way.path)) {
  console.warn(`warning: ${g2way.path} has uncommitted changes — comparing committed state only.`);
}

for (const d of missing) {
  console.warn(
    `warning: area '${d.area.id}' lists paths that no longer exist upstream: ${d.missing.join(', ')}`,
  );
}

if (unlocked.length > 0) {
  console.warn(
    `warning: ${unlocked.length} area(s) not in the lock yet: ${unlocked.map((d) => d.area.id).join(', ')}`,
  );
}

if (verbose) {
  const uncovered = uncoveredCrates(g2way.path, watch);
  if (uncovered.length > 0) {
    console.log(`note: g2way crates no watch area covers: ${uncovered.join(', ')}`);
  }
}

if (changed.length === 0) {
  if (lock.head !== head) {
    console.log(
      `g2way moved ${SHORT(lock.head)} → ${SHORT(head)}, but no watched area changed. Nothing to do.`,
    );
  } else if (verbose) {
    console.log(`In sync with g2way ${SHORT(head)}.`);
  }
  process.exit(0);
}

console.error(
  `\ng2way drift: ${changed.length} watched area(s) changed since ${SHORT(lock.head)} (now ${SHORT(head)}).\n`,
);
for (const d of changed) {
  console.error(`  ${d.area.id}`);
  console.error(`    drives:  ${d.area.surfaces.join(', ')}`);
  console.error(`    action:  ${d.area.onChange}`);
  const commits = commitsSince(g2way.path, lock.head, d.area);
  for (const c of commits.slice(0, 8)) console.error(`    upstream ${c}`);
  if (commits.length > 8) console.error(`    ... and ${commits.length - 8} more`);
  console.error('');
}
console.error('Run: npm run sync:g2way\n');
process.exit(1);
