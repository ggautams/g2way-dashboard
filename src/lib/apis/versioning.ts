/**
 * The API designer's versioning model: `versioning` (`VersioningConfig`) and
 * each version's `VersionOverrides`. The checks mirror
 * `VersioningConfig::validate` in `crates/g2-core/src/versioning.rs` (watched
 * as the `traffic-middleware` area); how an override replaces its base field
 * is `applyVersion` in chain.ts. Universal and pure: the client editor and
 * the tests share it.
 *
 * Every override is optional: present replaces the base field wholesale,
 * absent (or `null`) inherits it, and `[]` clears a list for that version.
 * Auth, the request size limit, CORS and the IP lists are built once around
 * the version dispatcher, so they cannot be overridden: every version shares
 * the base's.
 */

import type { components } from '../../../contracts/g2way.d.ts';
import { isHttpUrl, isTransformMethod } from './auth';
import type { ApiDefinition } from './list';
import { isHeaderName, listProblems, RULE_LISTS } from './rules';
import { bodyTransformProblems, headerTransformProblems } from './transforms';

type Schemas = components['schemas'];
export type VersioningConfig = Schemas['VersioningConfig'];
export type VersionOverrides = Schemas['VersionOverrides'];
export type VersionLocation = Schemas['VersionLocation'];
export type OverrideField = keyof VersionOverrides;

/** `DEFAULT_VERSION_KEY` (versioning.rs): the serde default for `key`. */
export const DEFAULT_VERSION_KEY = 'x-api-version';

/** Where the version is read from, in the order the editor offers them. */
export const VERSION_LOCATIONS = [
  'header',
  'query_param',
] as const satisfies readonly VersionLocation[];

/** The overrides the form edits per version, in chain order (`expires_at` is the dispatcher's). */
export const FORM_OVERRIDES = [
  'expires_at',
  ...RULE_LISTS,
  'transform_headers',
  'transform_body',
  'transform_method',
  'target_url',
] as const satisfies readonly OverrideField[];

/**
 * The overrides the form leaves to the JSON/YAML tabs, with the milestone
 * whose editor will take each on. The form never touches them: an edit keeps
 * them byte for byte.
 */
export const DEFERRED_OVERRIDES = {
  target_list: 'M7',
  upstream_timeout_ms: 'M7',
  upstream_retries: 'M7',
  upstream_http2: 'M7',
  enable_upgrades: 'M7',
  circuit_breaker: 'M7',
  health_check: 'M7',
  service_discovery: 'M7',
  cache: 'M7',
  graphql: 'M8',
  plugins: 'M9',
} as const satisfies Partial<Record<OverrideField, `M${number}`>>;

/**
 * Base fields a version cannot override: built once around the dispatcher
 * (chain slots 6, 7) or read from the base by every version (auth, size
 * limit), with the editor anchor (slot id) each lives under.
 */
export const SHARED_FIELDS = [
  { label: 'Authentication', slot: 'auth' },
  { label: 'Request size limit', slot: 'size-limit' },
  { label: 'CORS', slot: 'cors' },
  { label: 'IP allow/deny', slot: 'ip-filter' },
] as const;

/** A versioning problem's key: `versioning.key`, `versioning.versions.<name>.<field>`, …. */
export type VersioningProblemKey = `versioning.${string}`;
type Problems = Partial<Record<VersioningProblemKey, string>>;

/**
 * Where one version's problems are keyed. The name is encoded (dots too), so
 * a version called `a.b` cannot be mistaken for a field path.
 */
export function versionPrefix(name: string): `versioning.versions.${string}` {
  return `versioning.versions.${encodeURIComponent(name).replace(/\./g, '%2E')}`;
}

/** The DOM id prefix of one version's inputs (`version-v2.allow_paths`, …). */
export function versionDomId(name: string): string {
  return `version-${encodeURIComponent(name)}`;
}

// ---- edits -----------------------------------------------------------------------

/** The config versioning starts from: one version, `v1`, also the default, so clients see no change. */
export function newVersioning(): VersioningConfig {
  return { versions: { v1: {} }, default_version: 'v1' };
}

/**
 * `draft` with versioning on or off. Turning it back on restores the config
 * the definition was loaded with, if it had one; off drops every version.
 */
export function withVersioning(
  draft: ApiDefinition,
  on: boolean,
  original: VersioningConfig | null | undefined,
): ApiDefinition {
  const next = { ...draft };
  if (on) next.versioning = original ?? newVersioning();
  else delete next.versioning;
  return next;
}

/** `cfg` with one setting changed; `undefined` removes it (g2way's default). */
export function withSetting<K extends 'key' | 'location' | 'default_version'>(
  cfg: VersioningConfig,
  key: K,
  value: VersioningConfig[K] | undefined,
): VersioningConfig {
  const next = { ...cfg };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** The first `v<n>` not already a version name. */
export function nextVersionName(cfg: VersioningConfig): string {
  let n = Object.keys(cfg.versions).length + 1;
  while (`v${n}` in cfg.versions) n += 1;
  return `v${n}`;
}

/** `cfg` with a new version that overrides nothing (it serves the base as is). */
export function addVersion(cfg: VersioningConfig, name = nextVersionName(cfg)): VersioningConfig {
  return { ...cfg, versions: { ...cfg.versions, [name]: {} } };
}

/** `cfg` without `name`; a default pointing at it is dropped too (versions then required). */
export function removeVersion(cfg: VersioningConfig, name: string): VersioningConfig {
  const versions = { ...cfg.versions };
  delete versions[name];
  const next = { ...cfg, versions };
  if (next.default_version === name) delete next.default_version;
  return next;
}

/** `cfg` with `from` renamed to `to`, keeping its place, its overrides, and the default. */
export function renameVersion(cfg: VersioningConfig, from: string, to: string): VersioningConfig {
  if (from === to || !(from in cfg.versions)) return cfg;
  const versions = Object.fromEntries(
    Object.entries(cfg.versions).map(([name, overrides]) => [name === from ? to : name, overrides]),
  );
  const next = { ...cfg, versions };
  if (next.default_version === from) next.default_version = to;
  return next;
}

/** Why `to` cannot be a new name for version `from`, if it cannot. */
export function renameProblem(cfg: VersioningConfig, from: string, to: string): string | undefined {
  if (to === '' || to.trim() !== to) return 'Not empty, and no spaces around it.';
  if (to !== from && to in cfg.versions) return `There is already a version ${to}.`;
  return undefined;
}

/** `cfg` with one override of `version` set; `undefined` removes it (inherit the base). */
export function withOverride<K extends OverrideField>(
  cfg: VersioningConfig,
  version: string,
  field: K,
  value: VersionOverrides[K] | undefined,
): VersioningConfig {
  const overrides: VersionOverrides = { ...(cfg.versions[version] ?? {}) };
  if (value === undefined) delete overrides[field];
  else overrides[field] = value;
  return { ...cfg, versions: { ...cfg.versions, [version]: overrides } };
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

/** The overrides a version carries that the form leaves to JSON/YAML, in `DEFERRED_OVERRIDES` order. */
export function deferredOverrides(
  overrides: VersionOverrides,
): (keyof typeof DEFERRED_OVERRIDES)[] {
  return (Object.keys(DEFERRED_OVERRIDES) as (keyof typeof DEFERRED_OVERRIDES)[]).filter((field) =>
    present(overrides[field]),
  );
}

// ---- expiry ----------------------------------------------------------------------

/** `expires_at` (unix seconds) as a `datetime-local` value, read as UTC. */
export function formatExpiry(secs: number | null | undefined): string {
  if (secs === undefined || secs === null) return '';
  const date = new Date(secs * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 19);
}

/** A `datetime-local` value (UTC) as `expires_at`; blank is never (`undefined`). */
export function parseExpiry(
  text: string,
): { ok: true; value: number | undefined } | { ok: false; problem: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(trimmed)
    ? Date.parse(`${trimmed}Z`)
    : Number.NaN;
  if (Number.isNaN(ms)) return { ok: false, problem: 'Enter a date and time (UTC).' };
  return { ok: true, value: Math.floor(ms / 1000) };
}

/** Whether a version is expired at `nowSecs`: the boundary is inclusive, as in g2way. */
export function isExpired(secs: number | null | undefined, nowSecs: number): boolean {
  return secs !== undefined && secs !== null && nowSecs >= secs;
}

// ---- checks ----------------------------------------------------------------------

/**
 * `VersioningConfig::validate`: the key suits its location, there is at least
 * one version, names are non-empty and unpadded, the default names a version,
 * and each version's overrides pass the checks the base's fields do (the
 * effective definition's `validate`), plus the `target_url`-under-a-target-
 * list guard. Only override fields the form edits are checked here; the
 * gateway's 400 covers the rest.
 */
export function versioningProblems(draft: ApiDefinition): Problems {
  const problems: Problems = {};
  const cfg = draft.versioning;
  if (cfg === undefined || cfg === null) return problems;

  const location = cfg.location ?? 'header';
  const key = cfg.key ?? DEFAULT_VERSION_KEY;
  if (location === 'header' && !isHeaderName(key)) {
    problems['versioning.key'] = `Not a valid header name: ${key === '' ? '(empty)' : key}`;
  } else if (location === 'query_param' && key.trim() === '') {
    problems['versioning.key'] = 'Name the query parameter.';
  }

  const names = Object.keys(cfg.versions);
  if (names.length === 0) {
    problems['versioning.versions'] = 'Add at least one version, or turn versioning off.';
  }
  const def = cfg.default_version;
  if (def !== undefined && def !== null && !names.includes(def)) {
    problems['versioning.default_version'] = `${def} is not one of the versions.`;
  }

  for (const [name, overrides] of Object.entries(cfg.versions)) {
    const prefix = versionPrefix(name);
    if (name === '' || name.trim() !== name) {
      problems[`${prefix}.name`] = 'A version name must not be empty or padded with spaces.';
    }
    for (const list of RULE_LISTS) {
      if (!present(overrides[list])) continue;
      for (const [k, problem] of Object.entries(listProblems(list, overrides[list]))) {
        problems[`${prefix}.${k}`] = problem;
      }
    }
    Object.assign(
      problems,
      headerTransformProblems(overrides.transform_headers, `${prefix}.transform_headers`),
      bodyTransformProblems(overrides.transform_body, `${prefix}.transform_body`),
    );
    const method = overrides.transform_method;
    if (present(method) && !isTransformMethod(method as string)) {
      problems[`${prefix}.transform_method`] =
        `Not a method g2way can forward as (CONNECT never is): ${method}`;
    }
    const target = overrides.target_url;
    if (present(target)) {
      const targetList = overrides.target_list ?? draft.target_list ?? [];
      if (!isHttpUrl(target as string)) {
        problems[`${prefix}.target_url`] = 'Enter an absolute http:// or https:// URL.';
      } else if (targetList.length > 0) {
        problems[`${prefix}.target_url`] =
          'Has no effect while this version load-balances over a target list; override the target list (JSON/YAML) instead.';
      }
    }
  }
  return problems;
}

// ---- help ------------------------------------------------------------------------

/** Help text the versioning editor shows (g2way's rustdoc), read on the server by `apiHelp()`. */
export const VERSIONING_HELP_KEYS = [
  'key',
  'location',
  'default_version',
  'versions',
  'overrides',
  'expires_at',
  'target_url',
  'transform_method',
] as const;
export type VersioningHelp = Record<(typeof VERSIONING_HELP_KEYS)[number], string>;
