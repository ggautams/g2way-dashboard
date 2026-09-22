import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiChoice, ApiChoices } from '@/lib/designer/access';
import type { Outcome } from '@/lib/g2/gateway-status';
import type { Policy } from '@/lib/policies/list';
import { authFit, graphqlRules, resolveKeyAccess, type ResolveKeyAccessInput } from './access';

const NOW = 1_800_000_000;
const RATE = { requests: 10, per_seconds: 60 };
const QUOTA = { max: 1000, renewal_rate_secs: 86_400 };

const api = (id: string, extra: Partial<ApiChoice> = {}): ApiChoice => ({
  id,
  name: id.toUpperCase(),
  graphql: false,
  authMode: 'auth_token',
  active: true,
  ...extra,
});
const APIS: ApiChoices = {
  ok: true,
  value: [api('orders'), api('graph', { graphql: true }), api('ledger', { authMode: 'hmac' })],
};
const policy = (value: Partial<Policy> = {}): Outcome<Policy> => ({
  ok: true,
  value: { policy_id: 'gold', name: 'Gold', ...value },
});
const resolveWith = (input: Partial<ResolveKeyAccessInput>) =>
  resolveKeyAccess({ session: {}, policy: null, apis: APIS, nowSecs: NOW, ...input });

describe('resolveKeyAccess', () => {
  it('allows a plain active key with its own rate, quota and access', () => {
    const access = resolveWith({
      session: { rate: RATE, quota: QUOTA, access: { orders: {} } },
    });
    expect(access.status).toBe('allowed');
    expect(access.reasons).toEqual([]);
    expect(access.limits).toEqual({ source: 'key', rate: RATE, quota: QUOTA });
    expect(access.grant).toMatchObject({ known: true, source: 'key', everyApi: false });
    if (!access.grant.known) throw new Error('unreachable');
    expect(access.grant.rows.map((row) => row.apiId)).toEqual(['orders']);
    expect(access.grant.rows[0]?.graphql).toBeNull();
  });

  it('folds only the first of several apply_policies, and says so', () => {
    const access = resolveWith({
      session: { apply_policies: ['gold', 'silver'] },
      policy: policy({ access: { orders: {} } }),
    });
    expect(access.status).toBe('allowed');
    expect(access.reasons).toEqual([
      expect.objectContaining({ code: 'extra-policies', effect: 'note' }),
    ]);
    expect(access.limits).toMatchObject({ source: 'policy', policyId: 'gold' });
  });

  it("replaces the key's rate, quota and access with the policy's, entirely", () => {
    const access = resolveWith({
      session: {
        apply_policies: ['gold'],
        rate: RATE,
        quota: QUOTA,
        access: { orders: {}, graph: {} },
      },
      // No rate (unlimited) and a single API: nothing of the key's survives.
      policy: policy({ quota: { max: 5, renewal_rate_secs: 60 }, access: { ledger: {} } }),
    });
    expect(access.limits).toMatchObject({
      source: 'policy',
      rate: null,
      quota: { max: 5, renewal_rate_secs: 60 },
    });
    expect(access.ignoredKeyFields).toEqual(['rate', 'quota', 'access']);
    if (!access.grant.known) throw new Error('unreachable');
    expect(access.grant.source).toBe('policy');
    expect(access.grant.rows.map((row) => row.apiId)).toEqual(['ledger']);
  });

  it('an empty policy access grants every API even when the key names some', () => {
    const access = resolveWith({
      session: { apply_policies: ['gold'], access: { orders: {} } },
      policy: policy(),
    });
    if (!access.grant.known) throw new Error('unreachable');
    expect(access.grant.everyApi).toBe(true);
    expect(access.grant.rows.map((row) => row.apiId)).toEqual(['orders', 'graph', 'ledger']);
  });

  it('denies all for an inactive key', () => {
    const access = resolveWith({ session: { active: false, access: { orders: {} } } });
    expect(access.status).toBe('denied');
    expect(access.reasons.map((r) => r.code)).toEqual(['key-inactive']);
  });

  it('denies every key referencing an inactive policy', () => {
    const access = resolveWith({
      session: { apply_policies: ['gold'] },
      policy: policy({ active: false }),
    });
    expect(access.status).toBe('denied');
    expect(access.reasons.map((r) => r.code)).toEqual(['policy-inactive']);
  });

  it('denies a key whose policy is missing (404), quoting the gateway verbatim', () => {
    const access = resolveWith({
      session: { apply_policies: ['gone'], rate: RATE },
      policy: { ok: false, error: 'policy not found', status: 404 },
    });
    expect(access.status).toBe('denied');
    expect(access.reasons).toHaveLength(1);
    expect(access.reasons[0]).toMatchObject({ code: 'policy-missing', effect: 'denies' });
    expect(access.reasons[0]?.text).toContain(
      'GET /g2/policies/gone failed: policy not found (HTTP 404)',
    );
    expect(access.grant).toEqual({ known: false });
    expect(access.limits.source).toBe('policy-unavailable');
  });

  it('leaves the verdict unknown when the policy is unreadable for another reason', () => {
    const access = resolveWith({
      session: { apply_policies: ['gold'], access: { orders: {} } },
      policy: { ok: false, error: 'storage unavailable', status: 503 },
    });
    expect(access.status).toBe('unknown');
    expect(access.reasons[0]).toMatchObject({ code: 'policy-unreadable', effect: 'unknown' });
    expect(access.reasons[0]?.text).toContain('storage unavailable (HTTP 503)');
    // Never falls back to the key's own access.
    expect(access.grant).toEqual({ known: false });
    expect(resolveWith({ session: { apply_policies: ['gold'] } }).status).toBe('unknown');
  });

  it('a denial outranks an unreadable policy', () => {
    const access = resolveWith({
      session: { active: false, apply_policies: ['gold'] },
      policy: { ok: false, error: 'connection refused' },
    });
    expect(access.status).toBe('denied');
  });

  it('judges expires_at against now: at or before now denies', () => {
    expect(resolveWith({ session: { expires_at: NOW + 1 } }).status).toBe('allowed');
    const expired = resolveWith({ session: { expires_at: NOW } });
    expect(expired.status).toBe('denied');
    expect(expired.reasons.map((r) => r.code)).toEqual(['key-expired']);
    expect(expired.expiresAt).toBe(NOW);
    expect(resolveWith({ session: { expires_at: null } }).expiresAt).toBeNull();
  });

  it("expands an empty access to every API the environment lists, noting it can't list file-loaded ones", () => {
    const access = resolveWith({ session: { access: {} } });
    if (!access.grant.known) throw new Error('unreachable');
    expect(access.grant.everyApi).toBe(true);
    expect(access.grant.rows.map((row) => row.api?.name)).toEqual(['ORDERS', 'GRAPH', 'LEDGER']);
    expect(access.grant.apisError).toBeNull();

    const unlisted = resolveWith({ session: {}, apis: { ok: false, error: 'forbidden' } });
    if (!unlisted.grant.known) throw new Error('unreachable');
    expect(unlisted.grant).toMatchObject({ everyApi: true, rows: [], apisError: 'forbidden' });
    expect(unlisted.status).toBe('allowed');
  });

  it('marks granted ids the environment does not list', () => {
    const access = resolveWith({ session: { access: { 'from-file': {} } } });
    if (!access.grant.known) throw new Error('unreachable');
    expect(access.grant.rows[0]).toMatchObject({ apiId: 'from-file', api: null });
    expect(access.grant.rows[0]?.auth.kind).toBe('unknown');
  });

  it('carries per-API GraphQL restrictions', () => {
    const access = resolveWith({
      session: {
        access: {
          graph: {
            allowed_types: [{ name: 'Query', fields: ['user'] }],
            restricted_types: [{ name: 'Query', fields: ['admin'] }],
            disable_introspection: true,
            max_query_depth: 4,
          },
          orders: { max_query_depth: -1 },
        },
      },
    });
    if (!access.grant.known) throw new Error('unreachable');
    const [graph, orders] = access.grant.rows;
    expect(graph?.graphql).toEqual({
      allowed: [{ name: 'Query', fields: ['user'] }],
      restricted: [{ name: 'Query', fields: ['admin'] }],
      restrictedIgnored: true,
      introspectionDisabled: true,
      depth: { kind: 'override', depth: 4 },
    });
    expect(graph?.graphqlIgnored).toBe(false);
    // `orders` is not GraphQL-configured: the rule is carried but flagged as ignored.
    expect(orders?.graphql?.depth).toEqual({ kind: 'unlimited' });
    expect(orders?.graphqlIgnored).toBe(true);
    expect(graphqlRules({})).toBeNull();
    expect(graphqlRules({ restricted_types: [{ name: 'User' }] })).toMatchObject({
      restrictedIgnored: false,
      depth: { kind: 'inherit' },
    });
  });

  it('reports basic_auth and hmac credentials by presence, never their values', () => {
    const access = resolveWith({
      session: {
        basic_auth: { password_hash: '$2b$12$secret-hash' },
        hmac: { secret: 'plaintext-shared-secret' },
      },
    });
    expect(access.credentials).toEqual({ basicAuth: true, hmac: true });
    const text = JSON.stringify(access);
    expect(text).not.toContain('secret-hash');
    expect(text).not.toContain('plaintext-shared-secret');
    if (!access.grant.known) throw new Error('unreachable');
    expect(access.grant.rows.find((row) => row.apiId === 'ledger')?.auth.kind).toBe('usable');

    const bare = resolveWith({ session: {} });
    expect(bare.credentials).toEqual({ basicAuth: false, hmac: false });
    if (!bare.grant.known) throw new Error('unreachable');
    expect(bare.grant.rows.find((row) => row.apiId === 'ledger')?.auth.kind).toBe(
      'missing-credentials',
    );
  });

  it('fits each auth mode', () => {
    const none = { basicAuth: false, hmac: false };
    expect(authFit('keyless', none).kind).toBe('open');
    expect(authFit('auth_token', none).kind).toBe('usable');
    expect(authFit('mtls', none).kind).toBe('usable');
    expect(authFit('basic_auth', none).kind).toBe('missing-credentials');
    expect(authFit('basic_auth', { basicAuth: true, hmac: false }).kind).toBe('usable');
    expect(authFit('jwt', none).kind).toBe('not-key-auth');
    expect(authFit('oidc', none).kind).toBe('not-key-auth');
  });
});

describe('the Effective access section', () => {
  const SRC = resolve(import.meta.dirname, '../..');
  const section = readFileSync(resolve(SRC, 'components/keys/key-access.tsx'), 'utf8');

  it('is a Server Component', () => {
    expect(section).not.toMatch(/^\s*['"]use client['"]/m);
  });
});
