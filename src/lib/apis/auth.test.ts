import { describe, expect, it } from 'vitest';
import spec from '../../../contracts/openapi.json';
import { SECRET_MASK } from '@/lib/secrets/redact';
import {
  AUTH_FIELDS,
  authProblems,
  effectiveAuth,
  formatPolicyMap,
  isIpOrCidr,
  isTransformMethod,
  jwtKeySource,
  parsePolicyMap,
  withHmacAlgorithm,
  withJwtKeySource,
  withProp,
  withSigningMethod,
  type AuthConfig,
  type AuthOf,
} from './auth';
import { AUTH_MODES } from './list';

type Branch = { properties: Record<string, { enum?: string[] }> };

describe('AUTH_FIELDS', () => {
  it('lists every setting of every AuthConfig branch in the contract', () => {
    const branches = (spec.components.schemas.AuthConfig.oneOf as unknown as Branch[]).map(
      (branch) => [
        branch.properties.mode?.enum?.[0],
        Object.keys(branch.properties)
          .filter((key) => key !== 'mode')
          .sort(),
      ],
    );
    expect(Object.fromEntries(branches)).toEqual(
      Object.fromEntries(AUTH_MODES.map((mode) => [mode, [...AUTH_FIELDS[mode]].sort()])),
    );
  });
});

describe('editing helpers', () => {
  const jwt: AuthOf<'jwt'> = {
    mode: 'jwt',
    signing_method: 'rs256',
    jwks_url: 'https://idp/jwks',
    jwks_refresh_secs: 60,
    header: 'X-Token',
  };

  it('withProp sets or removes one property, leaving the rest', () => {
    expect(withProp(jwt, 'header', undefined)).not.toHaveProperty('header');
    expect(withProp(jwt, 'identity_claim', 'email')).toEqual({ ...jwt, identity_claim: 'email' });
    expect(jwt.header).toBe('X-Token');
  });

  it('an absent auth is token auth', () => {
    expect(effectiveAuth({ api_id: 'a', name: 'a', listen_path: '/', target_url: '' })).toEqual({
      mode: 'auth_token',
    });
  });

  it('switching signing method drops the other algorithm’s key material, and restores the original', () => {
    const hs = withSigningMethod(jwt, 'hs256', undefined);
    expect(hs).toEqual({ mode: 'jwt', signing_method: 'hs256', header: 'X-Token', secret: '' });
    expect(withSigningMethod(hs, 'rs256', jwt)).toEqual(jwt);
    expect(withSigningMethod(hs, 'rs256', undefined)).toEqual({
      mode: 'jwt',
      signing_method: 'rs256',
      header: 'X-Token',
      public_key_pem: '',
    });
  });

  it('switches an rs256 key between a PEM and a JWKS URL', () => {
    expect(jwtKeySource(jwt)).toBe('jwks');
    const pem = withJwtKeySource(jwt, 'pem');
    expect(pem).toEqual({
      mode: 'jwt',
      signing_method: 'rs256',
      header: 'X-Token',
      public_key_pem: '',
    });
    expect(jwtKeySource(pem)).toBe('pem');
    expect(withJwtKeySource(jwt, 'jwks')).toBe(jwt);
    expect(jwtKeySource(withJwtKeySource(pem, 'jwks'))).toBe('jwks');
  });

  it('keeps all three HMAC algorithms as the default, written only when narrowed', () => {
    const narrowed = withHmacAlgorithm({ mode: 'hmac' }, 'hmac-sha384', false);
    expect(narrowed.allowed_algorithms).toEqual(['hmac-sha256', 'hmac-sha512']);
    expect(withHmacAlgorithm(narrowed, 'hmac-sha384', true)).toEqual({ mode: 'hmac' });
  });

  it('parses and formats a policy map', () => {
    expect(parsePolicyMap(' app = gold \n\nweb=silver')).toEqual({
      ok: true,
      value: { app: 'gold', web: 'silver' },
    });
    expect(parsePolicyMap('')).toEqual({ ok: true, value: undefined });
    expect(parsePolicyMap('nope').ok).toBe(false);
    expect(formatPolicyMap({ app: 'gold' })).toBe('app = gold');
  });
});

describe('authProblems', () => {
  const check = (auth: AuthConfig) => authProblems(auth);

  it('passes sound configs and g2way’s defaults', () => {
    for (const mode of ['keyless', 'auth_token', 'basic_auth', 'mtls', 'hmac'] as const) {
      expect(check({ mode })).toEqual({});
    }
    expect(check({ mode: 'jwt', signing_method: 'hs256', secret: 's' })).toEqual({});
    expect(check({ mode: 'jwt', signing_method: 'rs256', public_key_pem: 'PEM' })).toEqual({});
    expect(
      check({ mode: 'oidc', issuer_url: 'https://idp.example/realm', audiences: ['api'] }),
    ).toEqual({});
    expect(check({ mode: 'hmac', allowed_clock_skew_secs: null })).toEqual({});
    expect(authProblems(undefined)).toEqual({});
  });

  it('mirrors AuthConfig::validate', () => {
    expect(
      check({ mode: 'auth_token', header: 'Bad Header', query_param: ' ', cookie: '' }),
    ).toEqual({
      header: 'Not a valid header name.',
      query_param: 'Must not be empty.',
      cookie: 'Must not be empty.',
    });
    expect(
      check({ mode: 'jwt', signing_method: 'hs256', public_key_pem: 'x', jwks_refresh_secs: 5 }),
    ).toEqual({
      secret: 'hs256 needs a secret.',
      public_key_pem: 'Not used with hs256.',
      jwks_refresh_secs: 'Only valid alongside a JWKS URL.',
    });
    expect(
      check({ mode: 'jwt', signing_method: 'rs256', secret: 's', identity_claim: ' ' }),
    ).toEqual({
      identity_claim: expect.any(String),
      public_key_pem: 'rs256 needs exactly one of a PEM public key or a JWKS URL.',
      secret: 'Not used with rs256.',
    });
    expect(
      check({ mode: 'jwt', signing_method: 'rs256', jwks_url: 'ftp://x', jwks_refresh_secs: 0 }),
    ).toEqual({
      jwks_url: 'Enter an absolute http(s) URL.',
      jwks_refresh_secs: 'Must be at least 1.',
    });
    expect(
      check({
        mode: 'oidc',
        issuer_url: 'https://idp?x=1',
        audiences: [],
        policy_claim: '',
        policy_map: { app: ' ' },
      }),
    ).toEqual({
      issuer_url: expect.stringContaining('without a query'),
      audiences: 'Name at least one audience.',
      policy_claim: expect.any(String),
      policy_map: expect.any(String),
    });
    expect(check({ mode: 'basic_auth', realm: 'say "hi"' })).toEqual({
      realm: expect.stringContaining('Printable ASCII'),
    });
    expect(
      check({
        mode: 'hmac',
        allowed_algorithms: ['hmac-sha256', 'hmac-sha256'],
        allowed_clock_skew_secs: 0,
      }),
    ).toEqual({
      allowed_algorithms: 'Must not repeat entries.',
      allowed_clock_skew_secs: expect.any(String),
    });
    expect(check({ mode: 'hmac', allowed_algorithms: [] }).allowed_algorithms).toBe(
      'Allow at least one.',
    );
  });

  it('refuses a secret carrying the ADR-0010 mask', () => {
    expect(check({ mode: 'jwt', signing_method: 'hs256', secret: SECRET_MASK }).secret).toMatch(
      /hidden from your role/,
    );
  });
});

describe('isTransformMethod', () => {
  it('accepts g2way’s methods in any case, never CONNECT', () => {
    expect(isTransformMethod('post')).toBe(true);
    expect(isTransformMethod('CONNECT')).toBe(false);
    expect(isTransformMethod('')).toBe(false);
  });
});

describe('isIpOrCidr', () => {
  it('accepts addresses and networks g2way parses', () => {
    for (const ok of [
      '10.0.0.1',
      '10.0.0.0/8',
      '0.0.0.0/0',
      '::1',
      '2001:db8::/32',
      '::ffff:10.0.0.1',
    ]) {
      expect(isIpOrCidr(ok), ok).toBe(true);
    }
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      'not-an-ip',
      '10.0.0.0/33',
      '10.0.0.0/99',
      '2001:db8::/129',
      '010.0.0.1',
      '10.0.0',
      '10.0.0.1/8/8',
      '10.0.0.1/',
      'example.com',
      '[::1]',
      '1::2::3',
    ]) {
      expect(isIpOrCidr(bad), bad).toBe(false);
    }
  });
});
