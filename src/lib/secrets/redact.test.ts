import { describe, expect, it } from 'vitest';
import { ROLES, can } from '@/lib/auth/rbac';
import type { JsonValue } from '@/lib/db/schema/shared';
import type { components } from '../../../contracts/g2way.d.ts';
import {
  REVEAL_PERMISSION,
  SECRET_MASK,
  SECRET_PATHS,
  SECRET_URL_MASK,
  SECRET_URL_PATHS,
  containsMask,
  findMasked,
  mayReveal,
  redactEachFor,
  redactFor,
  redactSecrets,
  type SecretPath,
} from './redact';

type Schemas = components['schemas'];
const M = SECRET_MASK;

/** One header map with a credential and a harmless header: a whole upstream map is masked. */
const upstreamHeaders = () => ({ authorization: 'Bearer up-token', 'x-trace': 'on' });
const maskedHeaders = { authorization: M, 'x-trace': M };

/** An API definition with a value at every secret path. */
function fullApi() {
  const graphql = {
    schema_sync: { url: 'http://up/graphql', headers: upstreamHeaders() },
    data_sources: {
      'Query.user': { kind: 'rest', url: 'http://up/u', headers: upstreamHeaders() },
    },
    supergraph: {
      subgraphs: [
        { name: 'a', url: 'http://a', sdl: 'type Query { a: Int }', headers: upstreamHeaders() },
      ],
    },
  };
  return {
    api_id: 'billing',
    name: 'Billing',
    listen_path: '/billing',
    target_url: 'http://billing',
    auth: {
      mode: 'jwt',
      signing_method: 'hs256',
      secret: 'jwt-shared-secret',
      header: 'Authorization',
    },
    transform_headers: {
      request: { add: upstreamHeaders(), remove: ['cookie'] },
      response: { add: { 'x-served-by': 'g2way' } },
    },
    graphql,
    versioning: {
      key: 'x-api-version',
      versions: {
        v2: { transform_headers: { request: { add: upstreamHeaders() } }, graphql },
      },
    },
    plugins: {
      pre: [{ name: 'p', path: 'p.wasm', config: { client_secret: 's3', region: 'eu' } }],
    },
    cors: { allowed_origins: ['*'], allow_credentials: true },
  } satisfies JsonValue;
}

describe('redactSecrets', () => {
  it('masks every API definition secret path, and nothing else', () => {
    const api = fullApi();
    const graphql = {
      schema_sync: { url: 'http://up/graphql', headers: maskedHeaders },
      data_sources: { 'Query.user': { kind: 'rest', url: 'http://up/u', headers: maskedHeaders } },
      supergraph: {
        subgraphs: [
          { name: 'a', url: 'http://a', sdl: 'type Query { a: Int }', headers: maskedHeaders },
        ],
      },
    };
    expect(redactSecrets('api', api)).toEqual({
      ...api,
      auth: { mode: 'jwt', signing_method: 'hs256', secret: M, header: 'Authorization' },
      transform_headers: {
        request: { add: maskedHeaders, remove: ['cookie'] },
        // Response headers go to clients, not upstream: not a credential path.
        response: { add: { 'x-served-by': 'g2way' } },
      },
      graphql,
      versioning: {
        key: 'x-api-version',
        versions: { v2: { transform_headers: { request: { add: maskedHeaders } }, graphql } },
      },
      // The name fallback, for an untyped plugin config.
      plugins: { pre: [{ name: 'p', path: 'p.wasm', config: { client_secret: M, region: 'eu' } }] },
    });
  });

  it('masks a key session’s hmac secret and basic-auth hash', () => {
    const session = {
      alias: 'batch',
      hmac: { secret: 'the-shared-secret' },
      basic_auth: { username: 'ada', password_hash: '$2b$12$abc' },
      access: { ledger: {} },
      active: true,
    };
    expect(redactSecrets('key', session)).toEqual({
      ...session,
      hmac: { secret: M },
      basic_auth: { username: 'ada', password_hash: M },
    });
  });

  it('leaves a policy as it is: the contract gives policies no secret', () => {
    const policy = { policy_id: 'gold', name: 'Gold', rate: { requests: 10, per_seconds: 1 } };
    expect(SECRET_PATHS.policy).toEqual([]);
    expect(redactSecrets('policy', policy)).toEqual(policy);
  });

  it('keeps the shape: adds nothing, keeps null and absent, never touches booleans', () => {
    const api = {
      api_id: 'a',
      auth: { mode: 'jwt', secret: null },
      graphql: null,
      transform_headers: { request: { add: {} } },
      cors: { allow_credentials: true },
    };
    expect(redactSecrets('api', api)).toEqual(api);
    const keyless = { api_id: 'b', auth: { mode: 'keyless' } };
    expect(redactSecrets('api', keyless)).toEqual(keyless);
    expect(redactSecrets('key', { hmac: null, basic_auth: null })).toEqual({
      hmac: null,
      basic_auth: null,
    });
  });

  it('is pure: the input is not modified', () => {
    const api = fullApi();
    const before = JSON.stringify(api);
    redactSecrets('api', api);
    expect(JSON.stringify(api)).toBe(before);
  });

  it('passes a non-object through', () => {
    expect(redactSecrets('key', null)).toBeNull();
    expect(redactSecrets('api', 'text')).toBe('text');
  });

  it('has a name fallback that errs toward hiding, but not where a credential goes', () => {
    const api = {
      auth: { mode: 'auth_token', header: 'X-Api-Key', cookie: 'session', query_param: 'token' },
      mock_responses: [
        { pattern: '/', headers: { 'X-Api-Key': 'k1', 'content-type': 'text/plain' } },
      ],
      jwt: { public_key_pem: '-----BEGIN PUBLIC KEY-----', jwks_url: 'http://idp/jwks' },
      extra: { password: 'p', private_key: 'k', access_token: 't', port: 8080 },
    };
    expect(redactSecrets('api', api)).toEqual({
      auth: { mode: 'auth_token', header: 'X-Api-Key', cookie: 'session', query_param: 'token' },
      mock_responses: [{ pattern: '/', headers: { 'X-Api-Key': M, 'content-type': 'text/plain' } }],
      jwt: { public_key_pem: '-----BEGIN PUBLIC KEY-----', jwks_url: 'http://idp/jwks' },
      extra: { password: M, private_key: M, access_token: M, port: 8080 },
    });
  });

  it('types every path against the contract', () => {
    // Compile-time checks: a path the contract lacks does not type-check.
    const ok: SecretPath<Schemas['KeySession']> = 'hmac.secret';
    // @ts-expect-error: KeySession has no `hmac.password`.
    const wrong: SecretPath<Schemas['KeySession']> = 'hmac.password';
    // @ts-expect-error: `auth.secret` exists, `auth.token` does not.
    const alsoWrong: SecretPath<Schemas['ApiDefinition']> = 'auth.token';
    expect([ok, wrong, alsoWrong]).toHaveLength(3);
  });
});

describe('credentials embedded in URLs (ADR-0010 §3)', () => {
  const U = SECRET_URL_MASK;

  /** Every typed URL field, each carrying userinfo and a credential query parameter. */
  function urlApi() {
    const upstream = {
      target_url: 'https://svc:pw@billing.internal:8443/api?region=eu&api_key=k',
      target_list: ['http://a.internal/?token=t', 'http://b.internal/'],
      service_discovery: { endpoint: 'http://consul:8500/v1/catalog?token=c' },
      graphql: {
        schema_sync: { url: 'https://ops:pw@introspect.internal/graphql' },
        data_sources: {
          'Query.user': { kind: 'rest', url: 'http://users/{{ args.id }}?sig=s&fields=all' },
        },
        supergraph: { subgraphs: [{ name: 'a', url: 'http://a/graphql?access_token=t' }] },
      },
    };
    return { api_id: 'billing', ...upstream, versioning: { versions: { v2: upstream } } };
  }

  it('masks only the credential parts of every typed URL field, top level and per version', () => {
    const upstream = {
      target_url: `https://${U}@billing.internal:8443/api?region=eu&api_key=${U}`,
      target_list: [`http://a.internal/?token=${U}`, 'http://b.internal/'],
      service_discovery: { endpoint: `http://consul:8500/v1/catalog?token=${U}` },
      graphql: {
        schema_sync: { url: `https://${U}@introspect.internal/graphql` },
        data_sources: {
          'Query.user': { kind: 'rest', url: `http://users/{{ args.id }}?sig=${U}&fields=all` },
        },
        supergraph: { subgraphs: [{ name: 'a', url: `http://a/graphql?access_token=${U}` }] },
      },
    };
    expect(redactSecrets('api', urlApi())).toEqual({
      api_id: 'billing',
      ...upstream,
      versioning: { versions: { v2: upstream } },
    });
  });

  it('keeps a masked URL parseable and its routing readable', () => {
    const { target_url } = redactSecrets('api', urlApi());
    const url = new URL(target_url);
    expect(url.host).toBe('billing.internal:8443');
    expect(url.pathname).toBe('/api');
    expect(url.searchParams.get('region')).toBe('eu');
    expect(url.searchParams.get('api_key')).toBe(M);
    expect(decodeURIComponent(url.username)).toBe(M);
    expect(url.password).toBe('');
  });

  it('lists the URL paths explicitly, APIs only', () => {
    expect(SECRET_URL_PATHS.api).toContain('target_url');
    expect(SECRET_URL_PATHS.api).toContain(
      'versioning.versions.*.graphql.supergraph.subgraphs.[].url',
    );
    expect(SECRET_URL_PATHS.policy).toEqual([]);
    expect(SECRET_URL_PATHS.key).toEqual([]);
    // @ts-expect-error: the contract has no `graphql.schema_sync.endpoint`.
    const wrong: SecretPath<Schemas['ApiDefinition']> = 'graphql.schema_sync.endpoint';
    expect(wrong).toBeDefined();
  });

  it('leaves a URL without credentials exactly as it was', () => {
    const api = { api_id: 'a', target_url: 'http://billing.svc:8000/api?region=eu' };
    expect(redactSecrets('api', api)).toEqual(api);
  });

  it('is found by the write guard, however the URL was re-encoded', () => {
    const masked = redactSecrets('api', urlApi());
    expect(findMasked(masked)).toContain('target_url');
    expect(findMasked(masked)).toContain(
      'versioning.versions.v2.graphql.supergraph.subgraphs.0.url',
    );
    expect(findMasked(masked)).not.toContain('target_list.1');
    expect(containsMask(new URL(masked.target_url).href)).toBe(true);
    expect(containsMask('http://h/?api_key=%5bsecret+hidden%5d')).toBe(true);
    expect(containsMask('http://h/?api_key=[secret hidden]')).toBe(true);
    expect(containsMask('http://h/?api_key=secret-hidden')).toBe(false);
  });
});

describe('who sees secrets', () => {
  it('is whoever holds the kind’s write permission', () => {
    for (const role of ROLES) {
      for (const kind of ['api', 'policy', 'key'] as const) {
        expect(mayReveal(role, kind)).toBe(can(role, REVEAL_PERMISSION[kind]));
      }
    }
    expect(REVEAL_PERMISSION).toEqual({
      api: 'apis:write',
      policy: 'policies:write',
      key: 'keys:write',
    });
  });

  it('hides key secrets from an editor, who can write APIs but not keys', () => {
    const session = { hmac: { secret: 's' } };
    expect(redactFor('editor', 'key', session)).toEqual({ hmac: { secret: M } });
    expect(redactFor('admin', 'key', session)).toBe(session);
    const api = fullApi();
    expect(redactFor('editor', 'api', api)).toBe(api);
    expect(redactFor('viewer', 'api', api).auth.secret).toBe(M);
  });

  it('redacts each record of a list', () => {
    const list = [fullApi(), fullApi()];
    expect(redactEachFor('viewer', 'api', list).map((api) => api.auth.secret)).toEqual([M, M]);
    expect(redactEachFor('owner', 'api', list)).toBe(list);
  });
});

describe('findMasked', () => {
  it('names where a body carries the mask', () => {
    expect(findMasked(redactSecrets('key', { alias: 'a', hmac: { secret: 's' } }))).toEqual([
      'hmac.secret',
    ]);
    expect(findMasked({ list: ['ok', M] })).toEqual(['list.1']);
    expect(findMasked(M)).toEqual(['(the body)']);
    expect(findMasked(fullApi())).toEqual([]);
  });
});
