// Shared plumbing for the g2way upstream sync/check scripts.
//
// The whole mechanism rests on one git property: `git rev-parse HEAD:<path>`
// returns the tree OID of a directory (or blob OID of a file), which changes
// if and only if that path's content changed. So an area can be fingerprinted
// without reading a single file, and unrelated upstream commits cause no churn
// here.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WATCH_PATH = resolve(repoRoot, 'contracts/watch.json');
export const LOCK_PATH = resolve(repoRoot, 'contracts/g2way.lock.json');

// Git exports these to hooks (`git commit -a` sets GIT_INDEX_FILE, for one).
// Inherited, they point `git -C ../g2way` at this repo's index or object
// store, which fails with "unable to read <oid>" or, worse, answers about
// the wrong repo. Every call here names its repo with `-C`, so drop them.
const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
];

export function cleanGitEnv(env = process.env) {
  const clean = { ...env };
  for (const name of GIT_LOCATION_VARS) delete clean[name];
  return clean;
}

/** Runs a command, returning trimmed stdout. Throws on a non-zero exit. */
export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', env: cleanGitEnv(), ...opts }).trim();
}

/** Runs a command, returning null instead of throwing. */
export function tryRun(cmd, args, opts = {}) {
  try {
    return run(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], ...opts });
  } catch {
    return null;
  }
}

export function readWatch() {
  return JSON.parse(readFileSync(WATCH_PATH, 'utf8'));
}

export function readLock() {
  return existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, 'utf8')) : null;
}

/**
 * Resolves the g2way checkout: --repo flag, then $G2WAY_REPO, then watch.json's
 * `repo`, each relative to this repo's root.
 */
export function resolveG2wayRepo(watch, cliRepo) {
  const raw = cliRepo || process.env.G2WAY_REPO || watch.repo || '../g2way';
  const path = isAbsolute(raw) ? raw : resolve(repoRoot, raw);
  const isRepo = existsSync(path) && tryRun('git', ['-C', path, 'rev-parse', '--git-dir']) !== null;
  return { path, raw, exists: isRepo };
}

export function headSha(repo) {
  return run('git', ['-C', repo, 'rev-parse', 'HEAD']);
}

export function isDirty(repo) {
  return run('git', ['-C', repo, 'status', '--porcelain']).length > 0;
}

/**
 * Content fingerprint for one area: the git OID of each path at HEAD, joined.
 * A path that does not exist upstream is recorded as `missing` rather than
 * failing — that is itself drift worth reporting.
 */
export function fingerprintArea(repo, area) {
  const parts = [];
  const missing = [];
  for (const p of area.paths) {
    const oid = tryRun('git', ['-C', repo, 'rev-parse', `HEAD:${p}`]);
    if (oid === null) {
      missing.push(p);
      parts.push(`${p}=missing`);
    } else {
      parts.push(`${p}=${oid}`);
    }
  }
  return { oid: parts.join(' '), missing };
}

/** Upstream commit subjects touching an area between two shas. */
export function commitsSince(repo, fromSha, area) {
  if (!fromSha) return [];
  const out = tryRun('git', [
    '-C',
    repo,
    'log',
    '--oneline',
    '--no-decorate',
    `${fromSha}..HEAD`,
    '--',
    ...area.paths,
  ]);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Compares every area against the lock. Returns per-area status. */
export function computeDrift(repo, watch, lock) {
  const locked = lock?.areas ?? {};
  return watch.areas.map((area) => {
    const { oid, missing } = fingerprintArea(repo, area);
    const previous = locked[area.id]?.oid ?? null;
    return {
      area,
      oid,
      previous,
      missing,
      drifted: previous !== null && previous !== oid,
      unlocked: previous === null,
    };
  });
}

/** Top-level g2way crates that no watch area covers — the area list rotting. */
export function uncoveredCrates(repo, watch) {
  const listed = tryRun('git', ['-C', repo, 'ls-tree', '--name-only', 'HEAD', 'crates/']);
  if (!listed) return [];
  const covered = watch.areas.flatMap((a) => a.paths);
  return listed
    .split('\n')
    .filter(Boolean)
    .filter((crate) => !covered.some((p) => p.startsWith(crate)));
}

export const SHORT = (sha) => (sha ? sha.slice(0, 7) : '(none)');
