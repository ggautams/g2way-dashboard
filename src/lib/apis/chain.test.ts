import { describe, expect, it } from 'vitest';
import {
  applyVersion,
  CHAIN_SLOTS,
  chainAnchor,
  chainFor,
  DISPATCHER_ID,
  EDITOR_SLOTS,
  editorAnchor,
  VERSION_EDITOR_SLOTS,
  FORWARDER_ID,
  type SlotStatus,
} from './chain';
import type { ApiDefinition } from './list';

const base: ApiDefinition = {
  api_id: 'orders',
  name: 'Orders',
  listen_path: '/orders/',
  target_url: 'http://orders:80',
};

const stateOf = (slots: SlotStatus[], id: string) => slots.find((s) => s.slot.id === id)?.state;
const onIds = (slots: SlotStatus[]) => slots.filter((s) => s.state === 'on').map((s) => s.slot.id);

describe('CHAIN_SLOTS', () => {
  it('pins chain.rs: 19 layers, outermost first', () => {
    expect(CHAIN_SLOTS.map((s) => s.layer)).toEqual([
      'TraceLayer',
      'MetricsLayer',
      'StatsLayer',
      'AnalyticsLayer',
      'SetContextLayer',
      'IpFilterLayer',
      'CorsLayer',
      'PathPolicyLayer',
      'RequestSizeLimitLayer',
      'PluginLayer',
      'AuthLayer',
      'RateLimitLayer',
      'PluginLayer',
      'GraphQlLayer',
      'HeaderTransformLayer',
      'BodyTransformLayer',
      'MockResponseLayer',
      'CacheLayer',
      'ApiIdHeaderLayer',
    ]);
    expect(CHAIN_SLOTS.map((s) => s.position)).toEqual(CHAIN_SLOTS.map((_, i) => i + 1));
    expect(new Set(CHAIN_SLOTS.map((s) => s.id)).size).toBe(19);
  });

  it('splits at build_outer (1–7) and build_inner (8–19)', () => {
    expect(CHAIN_SLOTS.filter((s) => s.scope === 'shared').map((s) => s.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('names gateway-wide and always-present slots', () => {
    expect(CHAIN_SLOTS.filter((s) => s.kind === 'gateway').map((s) => s.id)).toEqual([
      'trace',
      'metrics',
      'stats',
      'analytics',
    ]);
    expect(CHAIN_SLOTS.filter((s) => s.kind === 'always').map((s) => s.id)).toEqual([
      'set-context',
      'api-id-header',
    ]);
  });
});

describe('chainAnchor', () => {
  it('is stable, and per version for inner slots', () => {
    expect(chainAnchor('cors')).toBe('chain-cors');
    expect(chainAnchor('auth', 'v 2')).toBe('chain-v-v%202-auth');
  });
});

describe('chainFor, unversioned', () => {
  it('a bare definition has auth, rate limit and the two fixed slots', () => {
    const chain = chainFor(base);
    if (chain.versioned) throw new Error('expected unversioned');
    expect(chain.slots).toHaveLength(19);
    expect(onIds(chain.slots)).toEqual(['set-context', 'auth', 'rate-limit', 'api-id-header']);
    expect(stateOf(chain.slots, 'trace')).toBe('gateway');
    expect(chain.slots.find((s) => s.slot.id === 'auth')?.reason).toContain('auth_token');
    expect(chain.forwarder).toEqual({ target: 'http://orders:80', notes: [] });
  });

  it('keyless drops auth, and drops rate limiting unless endpoint limits exist', () => {
    const keyless: ApiDefinition = { ...base, auth: { mode: 'keyless' } };
    const a = chainFor(keyless);
    if (a.versioned) throw new Error('expected unversioned');
    expect(stateOf(a.slots, 'auth')).toBe('off');
    expect(stateOf(a.slots, 'rate-limit')).toBe('off');

    const b = chainFor({
      ...keyless,
      endpoint_rate_limits: [{ pattern: '/x', rate: { requests: 1, per_seconds: 1 } }],
    });
    if (b.versioned) throw new Error('expected unversioned');
    expect(stateOf(b.slots, 'rate-limit')).toBe('on');
  });

  it('switches each configured slot on from its field', () => {
    const chain = chainFor({
      ...base,
      allow_ips: ['10.0.0.0/8'],
      cors: { allowed_origins: ['*'] },
      ignore_auth_paths: [{ pattern: '/health' }],
      max_request_body_bytes: 1024,
      plugins: { pre: [{ name: 'p', path: '/p.wasm' }] },
      graphql: { schema: 'type Query { a: Int }' },
      transform_headers: {},
      transform_body: {},
      mock_responses: [{ pattern: '/m' }],
      cache: {},
    });
    if (chain.versioned) throw new Error('expected unversioned');
    expect(onIds(chain.slots)).toEqual(
      CHAIN_SLOTS.filter((s) => s.kind !== 'gateway' && s.id !== 'plugins-post').map((s) => s.id),
    );
  });

  it('empty lists and a disabled graphql block are off', () => {
    const chain = chainFor({
      ...base,
      allow_ips: [],
      block_paths: [],
      plugins: { pre: [], post: [] },
      graphql: { schema: 's', enabled: false },
    });
    if (chain.versioned) throw new Error('expected unversioned');
    for (const id of ['ip-filter', 'path-policy', 'plugins-pre', 'plugins-post', 'graphql']) {
      expect(stateOf(chain.slots, id)).toBe('off');
    }
  });

  it('udg and supergraph answer at slot 14: configured slots below are unreached, nothing forwarded', () => {
    for (const mode of ['udg', 'supergraph'] as const) {
      const chain = chainFor({
        ...base,
        graphql: { execution_mode: mode },
        cache: {},
        mock_responses: [],
      });
      if (chain.versioned) throw new Error('expected unversioned');
      expect(stateOf(chain.slots, 'graphql')).toBe('on');
      expect(stateOf(chain.slots, 'cache')).toBe('unreached');
      expect(stateOf(chain.slots, 'api-id-header')).toBe('unreached');
      expect(stateOf(chain.slots, 'mock')).toBe('off');
      expect(stateOf(chain.slots, 'auth')).toBe('on');
      expect(chain.forwarder.target).toBeNull();
    }
  });

  it('the forwarder reports URL rewrites, method override and load balancing', () => {
    const chain = chainFor({
      ...base,
      url_rewrites: [{ pattern: '^/a', rewrite: '/b' }],
      transform_method: 'POST',
      target_list: ['http://a', 'http://b'],
    });
    if (chain.versioned) throw new Error('expected unversioned');
    expect(chain.forwarder.target).toBe('2 targets, round-robin');
    expect(chain.forwarder.notes).toHaveLength(2);
  });
});

describe('chainFor, versioned', () => {
  const versioned: ApiDefinition = {
    ...base,
    cors: { allowed_origins: ['*'] },
    max_request_body_bytes: 10,
    cache: { ttl_secs: 5 },
    versioning: {
      default_version: 'v1',
      versions: {
        v1: {},
        v2: {
          mock_responses: [{ pattern: '/m' }],
          graphql: null,
          expires_at: 100,
          target_url: 'http://orders-v2:80',
        },
      },
    },
  };

  it('shares slots 1–7 and builds 8–19 per version', () => {
    const chain = chainFor(versioned);
    if (!chain.versioned) throw new Error('expected versioned');
    expect(chain.outer.map((s) => s.slot.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(stateOf(chain.outer, 'cors')).toBe('on');
    expect(chain.selector).toEqual({
      location: 'header',
      key: 'x-api-version',
      defaultVersion: 'v1',
    });
    expect(chain.versions.map((v) => v.name)).toEqual(['v1', 'v2']);
    for (const v of chain.versions) {
      expect(v.inner.map((s) => s.slot.position)).toEqual([
        8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ]);
      // auth and the size limit always come from the base
      expect(stateOf(v.inner, 'auth')).toBe('on');
      expect(stateOf(v.inner, 'size-limit')).toBe('on');
      expect(stateOf(v.inner, 'cache')).toBe('on');
    }
  });

  it('applies overrides wholesale; null and absent inherit', () => {
    const chain = chainFor(versioned);
    if (!chain.versioned) throw new Error('expected versioned');
    const [v1, v2] = chain.versions;
    expect(v1.isDefault).toBe(true);
    expect(v1.overrides).toEqual([]);
    expect(stateOf(v1.inner, 'mock')).toBe('off');
    expect(stateOf(v2.inner, 'mock')).toBe('on');
    expect(v2.overrides).toEqual(['mock_responses', 'target_url']);
    expect(v2.expiresAt).toBe(100);
    expect(v2.forwarder.target).toBe('http://orders-v2:80');
  });

  it('an explicitly empty list clears the base list', () => {
    const def = applyVersion({ ...base, allow_paths: [{ pattern: '/a' }] }, { allow_paths: [] });
    expect(def.allow_paths).toEqual([]);
    expect(def.versioning).toBeNull();
  });
});

describe('editor links', () => {
  it('names only real slots (or the forwarder or dispatcher), anchored as edit-<id>', () => {
    const ids = new Set([...CHAIN_SLOTS.map((slot) => slot.id), FORWARDER_ID, DISPATCHER_ID]);
    for (const id of EDITOR_SLOTS) expect(ids.has(id), id).toBe(true);
    expect(editorAnchor('auth')).toBe('edit-auth');
  });

  it('gives per-version editors only to per-version slots a VersionOverrides field reaches', () => {
    const perVersion = new Set([
      ...CHAIN_SLOTS.filter((slot) => slot.scope === 'per-version').map((slot) => slot.id),
      FORWARDER_ID,
    ]);
    for (const id of VERSION_EDITOR_SLOTS) {
      expect(perVersion.has(id), id).toBe(true);
      expect(EDITOR_SLOTS, id).toContain(id);
    }
    expect(VERSION_EDITOR_SLOTS).not.toContain('auth');
    expect(VERSION_EDITOR_SLOTS).not.toContain('size-limit');
    expect(editorAnchor('mock', 'v 2')).toBe('edit-v-v%202-mock');
  });
});
