import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import spec from '../../../contracts/openapi.json';
import { chainAnchor, CHAIN_SLOTS, DISPATCHER_ID, FORWARDER_ID } from './chain';
import type { ApiDefinition } from './list';
import {
  inferTrace,
  TRACE_UPSTREAM_ITEM,
  type Trace,
  type TraceRequest,
  type TraceResponse,
  type TraceVerdict,
} from './trace';

const BASE: ApiDefinition = {
  api_id: 'users',
  name: 'Users',
  listen_path: '/users/',
  target_url: 'http://upstream:9000',
};

const KEYLESS: ApiDefinition = { ...BASE, auth: { mode: 'keyless' } };

function req(overrides: Partial<TraceRequest> = {}): TraceRequest {
  return { method: 'GET', path: '/users/42', query: '', headers: [], bodyBytes: 0, ...overrides };
}

function res(status: number, overrides: Partial<TraceResponse> = {}): TraceResponse {
  return { status, headers: [], gatewayError: null, ...overrides };
}

const gatewayError = (status: number, message: string) => res(status, { gatewayError: message });

/** Verdict of step `id` (and version). */
function verdict(trace: Trace, id: string, version?: string): TraceVerdict | undefined {
  return trace.steps.find((s) => s.id === id && s.version === version)?.verdict;
}

function detail(trace: Trace, id: string, version?: string): string {
  return trace.steps.find((s) => s.id === id && s.version === version)?.detail ?? '';
}

const AUTHED = [['Authorization', 'k-123']] as const;

describe('inferTrace: the chain it walks', () => {
  it('lists every slot in chain order, then the forwarder, for an unversioned API', () => {
    const trace = inferTrace(KEYLESS, req(), res(200));
    expect(trace.steps.map((s) => s.id)).toEqual([...CHAIN_SLOTS.map((s) => s.id), FORWARDER_ID]);
    expect(trace.version).toBeNull();
  });

  it('marks slots the definition does not configure as off, and gateway-flag slots unknown', () => {
    const trace = inferTrace(KEYLESS, req(), res(200));
    expect(verdict(trace, 'ip-filter')).toBe('off');
    expect(verdict(trace, 'mock')).toBe('off');
    expect(verdict(trace, 'auth')).toBe('off');
    expect(verdict(trace, 'trace')).toBe('unknown');
    expect(verdict(trace, 'analytics')).toBe('unknown');
  });

  it('treats a plain 2xx without the error envelope as upstream-originated', () => {
    const trace = inferTrace(KEYLESS, req(), res(200));
    expect(trace.origin).toBe('upstream');
    expect(verdict(trace, FORWARDER_ID)).toBe('acted');
    expect(detail(trace, FORWARDER_ID)).toContain('Upstream path: /42 (listen path stripped)');
    expect(verdict(trace, 'api-id-header')).toBe('acted');
    expect(trace.mismatches).toEqual([]);
  });

  it('keeps the listen path when strip_listen_path is false, and names the method override', () => {
    const trace = inferTrace(
      { ...KEYLESS, strip_listen_path: false, transform_method: 'POST' },
      req(),
      res(200),
    );
    expect(detail(trace, FORWARDER_ID)).toContain('Upstream path: /users/42 (listen path kept)');
    expect(detail(trace, FORWARDER_ID)).toContain('Sent upstream as POST');
  });

  it('names the first url_rewrites rule that matches', () => {
    const trace = inferTrace(
      {
        ...KEYLESS,
        url_rewrites: [
          { pattern: '^/users/admin', rewrite: '/admin' },
          { pattern: '^/users/(\\d+)$', rewrite: '/profiles/$1' },
        ],
      },
      req(),
      res(200),
    );
    expect(detail(trace, FORWARDER_ID)).toContain('url_rewrites[1]');
    expect(detail(trace, FORWARDER_ID)).toContain('/profiles/$1');
  });
});

describe('inferTrace: path policy', () => {
  it('predicts a block_paths match as a 403 there, and nothing after it is reached', () => {
    const def = { ...KEYLESS, block_paths: [{ pattern: '^/users/4' }] };
    const trace = inferTrace(def, req(), gatewayError(403, 'forbidden path'));
    expect(verdict(trace, 'path-policy')).toBe('rejected');
    expect(verdict(trace, 'size-limit')).toBe('off');
    expect(verdict(trace, 'api-id-header')).toBe('not-reached');
    expect(verdict(trace, FORWARDER_ID)).toBe('not-reached');
    expect(trace.origin).toBe('gateway');
    expect(trace.summary).toContain('"forbidden path"');
  });

  it('respects a rule’s methods', () => {
    const def = { ...KEYLESS, block_paths: [{ pattern: '^/users/', methods: ['delete'] }] };
    const trace = inferTrace(def, req(), res(200));
    expect(verdict(trace, 'path-policy')).toBe('passed');
    expect(trace.origin).toBe('upstream');
    const deleted = inferTrace(def, req({ method: 'delete' }), gatewayError(403, 'x'));
    expect(verdict(deleted, 'path-policy')).toBe('rejected');
  });

  it('reports a prediction the response contradicts as a mismatch', () => {
    const def = { ...KEYLESS, block_paths: [{ pattern: '^/users/' }] };
    const trace = inferTrace(def, req(), res(200));
    expect(trace.mismatches).toEqual([
      expect.stringContaining('expected blocked path → 403, but the response was 200'),
    ]);
    expect(trace.origin).toBe('upstream');
  });

  it('predicts 403 for a path matching no allow_paths rule, and passes an allowed one', () => {
    const def = { ...KEYLESS, allow_paths: [{ pattern: '^/users/public' }] };
    expect(verdict(inferTrace(def, req(), gatewayError(403, 'x')), 'path-policy')).toBe('rejected');
    const allowed = inferTrace(def, req({ path: '/users/public/1' }), res(200));
    expect(verdict(allowed, 'path-policy')).toBe('passed');
    expect(detail(allowed, 'path-policy')).toContain('allow_paths[0]');
  });

  it('lets an ignore_auth_paths match stand auth down', () => {
    const def: ApiDefinition = { ...BASE, ignore_auth_paths: [{ pattern: '^/users/health$' }] };
    const trace = inferTrace(def, req({ path: '/users/health' }), res(200));
    expect(verdict(trace, 'path-policy')).toBe('acted');
    expect(verdict(trace, 'auth')).toBe('skipped');
    expect(trace.mismatches).toEqual([]);
  });

  it('says unknown when a pattern cannot be followed in JavaScript', () => {
    const def = { ...KEYLESS, block_paths: [{ pattern: '(?i)^/USERS/' }] };
    const trace = inferTrace(def, req(), gatewayError(403, 'x'));
    expect(detail(trace, 'path-policy')).toContain('cannot be followed');
    // The only candidate for the 403.
    expect(verdict(trace, 'path-policy')).toBe('rejected');
    expect(detail(trace, 'path-policy')).toContain('Most likely');
  });
});

describe('inferTrace: auth', () => {
  it('predicts a rejection when the credential is missing (auth absent = auth_token)', () => {
    const trace = inferTrace(BASE, req(), gatewayError(401, 'missing credential'));
    expect(verdict(trace, 'auth')).toBe('rejected');
    expect(detail(trace, 'auth')).toContain('no credential in the Authorization header');
    expect(verdict(trace, 'rate-limit')).toBe('not-reached');
  });

  it('reads the configured header, query parameter and cookie for auth_token', () => {
    const def: ApiDefinition = {
      ...BASE,
      auth: { mode: 'auth_token', header: 'X-Api-Key', query_param: 'key', cookie: 'session' },
    };
    for (const request of [
      req({ headers: [['x-api-key', 'k']] }),
      req({ query: 'key=k' }),
      req({ headers: [['Cookie', 'a=1; session=k']] }),
    ]) {
      const trace = inferTrace(def, request, res(200));
      expect(detail(trace, 'auth')).toContain('a credential is present');
      expect(trace.mismatches).toEqual([]);
    }
    const missing = inferTrace(def, req({ headers: [['Authorization', 'k']] }), res(200));
    expect(missing.mismatches).toHaveLength(1);
  });

  it('knows hmac wants a Signature and basic_auth a Basic Authorization header', () => {
    const hmac: ApiDefinition = { ...BASE, auth: { mode: 'hmac' } };
    expect(detail(inferTrace(hmac, req({ headers: [...AUTHED] }), res(200)), 'auth')).toContain(
      'no credential',
    );
    expect(
      detail(
        inferTrace(hmac, req({ headers: [['authorization', 'Signature keyId="a"']] }), res(200)),
        'auth',
      ),
    ).toContain('present');
    const basic: ApiDefinition = { ...BASE, auth: { mode: 'basic_auth' } };
    expect(
      detail(
        inferTrace(basic, req({ headers: [['Authorization', 'Basic eDp5']] }), res(200)),
        'auth',
      ),
    ).toContain('present');
  });

  it('says the console cannot present a client certificate for mtls', () => {
    const def: ApiDefinition = { ...BASE, auth: { mode: 'mtls' } };
    const trace = inferTrace(def, req(), gatewayError(401, 'client certificate required'));
    expect(verdict(trace, 'auth')).toBe('rejected');
    expect(detail(trace, 'auth')).toContain('cannot present');
  });

  it('makes a present credential the likely cause of an unexplained 403', () => {
    const trace = inferTrace(BASE, req({ headers: [...AUTHED] }), gatewayError(403, 'bad key'));
    expect(verdict(trace, 'auth')).toBe('rejected');
    expect(trace.origin).toBe('gateway');
  });

  it('lists every candidate when more than one slot could have answered', () => {
    const def: ApiDefinition = { ...BASE, allow_ips: ['10.0.0.0/8'] };
    const trace = inferTrace(def, req({ headers: [...AUTHED] }), gatewayError(403, 'nope'));
    expect(verdict(trace, 'ip-filter')).toBe('possible');
    expect(verdict(trace, 'auth')).toBe('possible');
    expect(verdict(trace, 'rate-limit')).toBe('not-reached');
    expect(trace.summary).toContain('IP allow/deny, Authentication');
  });

  it('prefers an earlier uncertain slot over a later prediction the status does not fit', () => {
    // The body is over the limit (413 expected), but a 403 came back: the IP
    // filter above the size limit explains it, so it is not a mismatch.
    const def: ApiDefinition = { ...KEYLESS, block_ips: ['1.2.3.4'], max_request_body_bytes: 1 };
    const trace = inferTrace(def, req({ bodyBytes: 5 }), gatewayError(403, 'blocked'));
    expect(trace.mismatches).toEqual([]);
    expect(verdict(trace, 'ip-filter')).toBe('rejected');
    expect(verdict(trace, 'size-limit')).toBe('not-reached');
  });

  it('lets a deterministic prediction win over an earlier candidate with the same status', () => {
    const def: ApiDefinition = { ...BASE, block_ips: ['1.2.3.4'] };
    const trace = inferTrace(def, req(), gatewayError(403, 'no key'));
    expect(verdict(trace, 'auth')).toBe('rejected');
    expect(verdict(trace, 'ip-filter')).toBe('unknown');
  });
});

describe('inferTrace: limits, mocks, cache, CORS, transforms', () => {
  it('predicts 413 for a body over max_request_body_bytes', () => {
    const def = { ...KEYLESS, max_request_body_bytes: 10 };
    const trace = inferTrace(def, req({ method: 'POST', bodyBytes: 11 }), gatewayError(413, 'x'));
    expect(verdict(trace, 'size-limit')).toBe('rejected');
    expect(verdict(inferTrace(def, req({ bodyBytes: 10 }), res(200)), 'size-limit')).toBe('passed');
  });

  it('puts a 429 on the rate-limit slot and quotes the X-RateLimit headers', () => {
    const def: ApiDefinition = {
      ...KEYLESS,
      endpoint_rate_limits: [{ pattern: '^/users/', rate: { requests: 2, per_seconds: 60 } }],
    };
    const trace = inferTrace(def, req(), {
      status: 429,
      gatewayError: 'rate limit exceeded',
      headers: [
        ['X-RateLimit-Limit', '2'],
        ['X-RateLimit-Remaining', '0'],
        ['Retry-After', '30'],
      ],
    });
    expect(verdict(trace, 'rate-limit')).toBe('rejected');
    expect(detail(trace, 'rate-limit')).toContain('2 per 60 s');
    expect(detail(trace, 'rate-limit')).toContain('x-ratelimit-remaining: 0');
    expect(detail(trace, 'rate-limit')).toContain('retry-after: 30');
  });

  it('counts an authenticated request against the session rate', () => {
    const trace = inferTrace(BASE, req({ headers: [...AUTHED] }), res(200));
    expect(verdict(trace, 'rate-limit')).toBe('acted');
    expect(detail(trace, 'rate-limit')).toContain("session's rate");
  });

  it('answers from a matching mock, after the header transforms', () => {
    const def: ApiDefinition = {
      ...KEYLESS,
      transform_headers: { response: { add: { 'X-Gateway': 'g2way' } } },
      mock_responses: [{ pattern: '^/users/42$', status: 418, body: 'teapot' }],
    };
    const trace = inferTrace(def, req(), res(418, { headers: [['x-gateway', 'g2way']] }));
    expect(verdict(trace, 'mock')).toBe('answered');
    expect(trace.origin).toBe('mock');
    expect(verdict(trace, 'transform-headers')).toBe('acted');
    expect(detail(trace, 'transform-headers')).toContain('Seen on the response: X-Gateway');
    expect(verdict(trace, FORWARDER_ID)).toBe('not-reached');
  });

  it('defaults a mock to 200 and flags one the response contradicts', () => {
    const def: ApiDefinition = { ...KEYLESS, mock_responses: [{ pattern: '^/users/' }] };
    expect(inferTrace(def, req(), res(200)).origin).toBe('mock');
    expect(inferTrace(def, req(), res(201)).mismatches).toHaveLength(1);
  });

  it('reads x-g2-cache: hit as a cache answer, and never caches unsafe methods', () => {
    const def: ApiDefinition = { ...KEYLESS, cache: { ttl_secs: 60 } };
    const hit = inferTrace(def, req(), res(200, { headers: [['X-G2-Cache', 'hit']] }));
    expect(verdict(hit, 'cache')).toBe('answered');
    expect(hit.origin).toBe('cache');
    expect(verdict(hit, FORWARDER_ID)).toBe('not-reached');
    expect(verdict(inferTrace(def, req(), res(200)), 'cache')).toBe('passed');
    expect(verdict(inferTrace(def, req({ method: 'POST' }), res(200)), 'cache')).toBe('skipped');
  });

  it('shows CORS decorating a response, and the gateway answering a preflight', () => {
    const def: ApiDefinition = { ...KEYLESS, cors: { allowed_origins: ['https://app.example'] } };
    const origin = ['Origin', 'https://app.example'] as const;
    const simple = inferTrace(
      def,
      req({ headers: [origin] }),
      res(200, { headers: [['access-control-allow-origin', 'https://app.example']] }),
    );
    expect(verdict(simple, 'cors')).toBe('acted');
    const preflight = inferTrace(
      def,
      req({ method: 'OPTIONS', headers: [origin, ['Access-Control-Request-Method', 'PUT']] }),
      res(204),
    );
    expect(verdict(preflight, 'cors')).toBe('answered');
    expect(verdict(preflight, FORWARDER_ID)).toBe('not-reached');
    const passthrough = inferTrace(
      { ...def, cors: { ...def.cors!, options_passthrough: true } },
      req({ method: 'OPTIONS', headers: [origin, ['Access-Control-Request-Method', 'PUT']] }),
      res(204),
    );
    expect(passthrough.origin).toBe('upstream');
    expect(verdict(inferTrace(def, req(), res(200)), 'cors')).toBe('passed');
  });

  it('names the body-transform rules that match', () => {
    const def: ApiDefinition = {
      ...KEYLESS,
      transform_body: { request: [{ pattern: '^/users/', template: '{}', methods: ['POST'] }] },
    };
    expect(verdict(inferTrace(def, req(), res(200)), 'transform-body')).toBe('passed');
    const posted = inferTrace(def, req({ method: 'POST' }), res(200));
    expect(verdict(posted, 'transform-body')).toBe('acted');
    expect(detail(posted, 'transform-body')).toContain('transform_body.request[0]');
  });

  it('never echoes a header value, only names', () => {
    const def: ApiDefinition = {
      ...BASE,
      transform_headers: { request: { add: { 'X-Upstream-Key': 'super-secret-value' } } },
    };
    const trace = inferTrace(
      def,
      req({ headers: [['Authorization', 'Bearer user-secret']] }),
      res(200),
    );
    const text = JSON.stringify(trace);
    expect(text).toContain('X-Upstream-Key');
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain('user-secret');
  });

  it('puts a gateway-style 502 on the forwarder', () => {
    const trace = inferTrace(KEYLESS, req(), gatewayError(502, 'upstream unreachable'));
    expect(verdict(trace, FORWARDER_ID)).toBe('rejected');
    expect(trace.summary).toContain('forwarder');
  });

  it('says so when an error envelope matches no modelled slot', () => {
    const trace = inferTrace(KEYLESS, req(), gatewayError(404, 'no route'));
    expect(trace.origin).toBe('unknown');
    expect(trace.summary).toContain('"no route"');
  });
});

describe('inferTrace: versioned APIs', () => {
  const VERSIONED: ApiDefinition = {
    ...KEYLESS,
    versioning: {
      default_version: 'v1',
      versions: {
        v1: {},
        v2: { block_paths: [{ pattern: '^/users/' }] },
        old: { expires_at: 1_000 },
      },
    },
  };

  it('uses the default version when the request names none', () => {
    const trace = inferTrace(VERSIONED, req(), res(200), 2_000);
    expect(trace.version).toEqual({ name: 'v1', source: 'the default version' });
    expect(verdict(trace, DISPATCHER_ID)).toBe('acted');
    expect(verdict(trace, 'path-policy', 'v1')).toBe('off');
    expect(verdict(trace, FORWARDER_ID, 'v1')).toBe('acted');
    // Shared slots carry no version.
    expect(verdict(trace, 'cors')).toBe('off');
  });

  it("applies the named version's overrides (header selector, case-insensitive)", () => {
    const trace = inferTrace(
      VERSIONED,
      req({ headers: [['X-API-Version', 'v2']] }),
      gatewayError(403, 'x'),
      2_000,
    );
    expect(trace.version).toEqual({ name: 'v2', source: 'from the header x-api-version' });
    expect(verdict(trace, 'path-policy', 'v2')).toBe('rejected');
  });

  it('reads a query-parameter selector', () => {
    const def: ApiDefinition = {
      ...VERSIONED,
      versioning: { ...VERSIONED.versioning!, location: 'query_param', key: 'v' },
    };
    const trace = inferTrace(def, req({ query: 'v=v2' }), gatewayError(403, 'x'), 2_000);
    expect(trace.version?.name).toBe('v2');
  });

  it('predicts the dispatcher’s rejection for a missing, unknown or expired version', () => {
    const noDefault: ApiDefinition = {
      ...VERSIONED,
      versioning: { ...VERSIONED.versioning!, default_version: null },
    };
    const missing = inferTrace(noDefault, req(), gatewayError(403, 'version required'), 2_000);
    expect(verdict(missing, DISPATCHER_ID)).toBe('rejected');
    expect(missing.steps.some((s) => s.version !== undefined)).toBe(false);

    const unknown = inferTrace(
      VERSIONED,
      req({ headers: [['x-api-version', 'v9']] }),
      gatewayError(404, 'unknown version'),
      2_000,
    );
    expect(verdict(unknown, DISPATCHER_ID)).toBe('rejected');
    expect(detail(unknown, DISPATCHER_ID)).toContain('No version "v9"');

    const expired = inferTrace(
      VERSIONED,
      req({ headers: [['x-api-version', 'old']] }),
      gatewayError(403, 'version expired'),
      1_000,
    );
    expect(verdict(expired, DISPATCHER_ID)).toBe('rejected');
    expect(detail(expired, DISPATCHER_ID)).toContain('expired');
  });

  it('gives per-version steps anchors that exist in the Chain tab', () => {
    const trace = inferTrace(VERSIONED, req(), res(200), 2_000);
    const anchors = trace.steps.map((s) => chainAnchor(s.id, s.version));
    expect(anchors).toContain('chain-v-v1-path-policy');
    expect(anchors).toContain('chain-cors');
    expect(anchors).toContain(`chain-${DISPATCHER_ID}`);
  });
});

describe('the real trace (UPSTREAM.md)', () => {
  it('points at the UPSTREAM.md item', () => {
    const upstream = readFileSync(resolve(import.meta.dirname, '../../../UPSTREAM.md'), 'utf8');
    expect(upstream).toContain(`**${TRACE_UPSTREAM_ITEM}**`);
  });

  // When g2way documents a per-request trace (a debug/trace endpoint, or a
  // trace header in its OpenAPI), this fails: show the gateway's real trace in
  // the console instead of (or beside) the inferred one, tick the UPSTREAM.md
  // box and the ROADMAP task.
  it('has no gateway trace to read yet', () => {
    expect(Object.keys(spec.paths).filter((path) => /trace|debug/i.test(path))).toEqual([]);
    expect(JSON.stringify(spec)).not.toMatch(/x-g2-(trace|debug)/i);
  });
});
