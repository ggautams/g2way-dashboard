import { describe, expect, it } from 'vitest';
import spec from '../../../contracts/openapi.json';
import { draftProblems, otherFields } from './draft';
import type { ApiDefinition } from './list';
import {
  addVersion,
  DEFERRED_OVERRIDES,
  deferredOverrides,
  formatExpiry,
  FORM_OVERRIDES,
  isExpired,
  newVersioning,
  nextVersionName,
  parseExpiry,
  removeVersion,
  renameProblem,
  renameVersion,
  versioningProblems,
  versionPrefix,
  withOverride,
  withSetting,
  withVersioning,
  type VersioningConfig,
} from './versioning';

const base: ApiDefinition = {
  api_id: 'orders',
  name: 'Orders',
  listen_path: '/orders/',
  target_url: 'http://orders:80',
};

const versioned = (versioning: VersioningConfig, extra: Partial<ApiDefinition> = {}) =>
  ({ ...base, ...extra, versioning }) as ApiDefinition;

describe('override coverage', () => {
  it('sorts every VersionOverrides field into the form or the JSON/YAML list, once', () => {
    const fields = Object.keys(spec.components.schemas.VersionOverrides.properties).sort();
    const covered = [...FORM_OVERRIDES, ...Object.keys(DEFERRED_OVERRIDES)];
    expect([...covered].sort()).toEqual(fields);
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('files each deferred override under the milestone that owns its editor', () => {
    expect(DEFERRED_OVERRIDES.plugins).toBe('M9');
    expect(DEFERRED_OVERRIDES.graphql).toBe('M8');
    expect(DEFERRED_OVERRIDES.cache).toBe('M7');
    expect(DEFERRED_OVERRIDES.target_list).toBe('M7');
  });

  it('makes versioning a form field, so it is no longer "the rest"', () => {
    expect(otherFields(versioned(newVersioning()))).toEqual([]);
  });
});

describe('edits', () => {
  it('starts with v1 as the default, and restores the loaded config when turned back on', () => {
    expect(withVersioning(base, true, undefined).versioning).toEqual({
      versions: { v1: {} },
      default_version: 'v1',
    });
    const loaded: VersioningConfig = { versions: { a: { expires_at: 5 } }, key: 'v' };
    const off = withVersioning(versioned(loaded), false, loaded);
    expect(off).not.toHaveProperty('versioning');
    expect(withVersioning(off, true, loaded).versioning).toBe(loaded);
  });

  it('adds, renames and removes versions, keeping the default in step', () => {
    let cfg = addVersion(newVersioning());
    expect(Object.keys(cfg.versions)).toEqual(['v1', 'v2']);
    expect(nextVersionName({ versions: { v2: {} } })).toBe('v3');
    cfg = withOverride(cfg, 'v1', 'transform_method', 'POST');
    cfg = renameVersion(cfg, 'v1', 'legacy');
    expect(Object.keys(cfg.versions)).toEqual(['legacy', 'v2']);
    expect(cfg.versions.legacy).toEqual({ transform_method: 'POST' });
    expect(cfg.default_version).toBe('legacy');
    cfg = removeVersion(cfg, 'legacy');
    expect(cfg).toEqual({ versions: { v2: {} } });
  });

  it('refuses a rename g2way would refuse, or one that collides', () => {
    const cfg: VersioningConfig = { versions: { v1: {}, v2: {} } };
    expect(renameProblem(cfg, 'v1', '')).toBeDefined();
    expect(renameProblem(cfg, 'v1', ' v3')).toBeDefined();
    expect(renameProblem(cfg, 'v1', 'v2')).toMatch(/already/);
    expect(renameProblem(cfg, 'v1', 'v1')).toBeUndefined();
    expect(renameProblem(cfg, 'v1', 'v3')).toBeUndefined();
  });

  it('sets and unsets overrides and settings, leaving every other field alone', () => {
    const cfg: VersioningConfig = {
      versions: { v1: { cache: { ttl_secs: 5 } as never, plugins: { pre: [] } as never } },
    };
    const next = withOverride(cfg, 'v1', 'allow_paths', []);
    expect(next.versions.v1).toEqual({ ...cfg.versions.v1, allow_paths: [] });
    expect(withOverride(next, 'v1', 'allow_paths', undefined)).toEqual(cfg);
    expect(withSetting(withSetting(cfg, 'key', 'v'), 'key', undefined)).toEqual(cfg);
    expect(deferredOverrides(cfg.versions.v1 ?? {})).toEqual(['cache', 'plugins']);
    expect(deferredOverrides({ cache: null, allow_paths: [] })).toEqual([]);
  });
});

describe('expiry', () => {
  it('round-trips unix seconds through a UTC datetime-local value', () => {
    expect(formatExpiry(1_800_000_000)).toBe('2027-01-15T08:00:00');
    expect(parseExpiry('2027-01-15T08:00:00')).toEqual({ ok: true, value: 1_800_000_000 });
    expect(parseExpiry('2027-01-15T08:00')).toEqual({ ok: true, value: 1_800_000_000 });
    expect(parseExpiry(' ')).toEqual({ ok: true, value: undefined });
    expect(parseExpiry('tomorrow')).toMatchObject({ ok: false });
    expect(formatExpiry(undefined)).toBe('');
  });

  it('treats the boundary as expired, like g2way', () => {
    expect(isExpired(10, 10)).toBe(true);
    expect(isExpired(10, 9)).toBe(false);
    expect(isExpired(null, 9)).toBe(false);
  });
});

describe('versioningProblems (VersioningConfig::validate)', () => {
  it('passes a sound config, and checks nothing when unversioned', () => {
    expect(versioningProblems(base)).toEqual({});
    expect(versioningProblems(versioned(newVersioning()))).toEqual({});
  });

  it('checks the key for its location', () => {
    expect(versioningProblems(versioned({ key: 'bad header', versions: { v1: {} } }))).toEqual({
      'versioning.key': expect.stringContaining('header name'),
    });
    expect(
      versioningProblems(versioned({ location: 'query_param', key: '  ', versions: { v1: {} } })),
    ).toEqual({ 'versioning.key': expect.any(String) });
    expect(
      versioningProblems(versioned({ location: 'query_param', key: 'v', versions: { v1: {} } })),
    ).toEqual({});
  });

  it('needs a version, clean names, and a default that exists', () => {
    expect(versioningProblems(versioned({ versions: {} }))).toEqual({
      'versioning.versions': expect.any(String),
    });
    expect(Object.keys(versioningProblems(versioned({ versions: { ' v1': {}, v2: {} } })))).toEqual(
      [`${versionPrefix(' v1')}.name`],
    );
    expect(versioningProblems(versioned({ default_version: 'v2', versions: { v1: {} } }))).toEqual({
      'versioning.default_version': 'v2 is not one of the versions.',
    });
  });

  it('checks each version’s overrides as the base’s fields, keyed under its prefix', () => {
    const p = versionPrefix('v2');
    const problems = versioningProblems(
      versioned({
        versions: {
          v2: {
            target_url: 'not-a-url',
            transform_method: 'CONNECT',
            url_rewrites: [{ pattern: '(', rewrite: '/x' }],
            transform_headers: { response: { add: { Connection: 'close' } } },
            transform_body: {},
          },
        },
      }),
    );
    expect(Object.keys(problems).sort()).toEqual(
      [
        `${p}.target_url`,
        `${p}.transform_body`,
        `${p}.transform_headers.response.add`,
        `${p}.transform_method`,
        `${p}.url_rewrites.0.pattern`,
      ].sort(),
    );
  });

  it('refuses a target_url override under an effective target list', () => {
    const p = versionPrefix('v2');
    const cfg: VersioningConfig = { versions: { v2: { target_url: 'http://v2:80' } } };
    expect(versioningProblems(versioned(cfg, { target_list: ['http://a:80'] }))).toEqual({
      [`${p}.target_url`]: expect.stringContaining('target list'),
    });
    expect(
      versioningProblems(
        versioned(
          { versions: { v2: { target_url: 'http://v2:80', target_list: [] } } },
          { target_list: ['http://a:80'] },
        ),
      ),
    ).toEqual({});
  });

  it('encodes version names, so a dotted name cannot pose as a field path', () => {
    expect(versionPrefix('a.b')).toBe('versioning.versions.a%2Eb');
  });

  it('is merged into draftProblems', () => {
    expect(draftProblems(versioned({ versions: {} }))).toEqual({
      'versioning.versions': expect.any(String),
    });
  });
});
