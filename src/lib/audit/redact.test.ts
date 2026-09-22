import { describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOT_BYTES,
  REDACTED,
  REDACTED_CHANGED,
  REDACTED_CHANGED_URL,
  REDACTED_URL,
  capSnapshot,
  redactSnapshot,
  snapshotKind,
} from './redact';

describe('redactSnapshot', () => {
  it('hides every secret the gateway schemas carry, at any depth', () => {
    const api = {
      api_id: 'billing',
      auth: { mode: 'jwt', secret: 'hs256-secret', header: 'Authorization' },
      transform_headers: {
        request: { add: { Authorization: 'Bearer upstream', 'X-Api-Key': 'k1', 'X-Env': 'prod' } },
      },
      graphql: { schema_sync: { headers: { authorization: 'Bearer t' }, interval_ms: 1000 } },
      cors: { allow_credentials: true },
      versioning: { key: 'x-version' },
    };
    expect(redactSnapshot(api)).toEqual({
      api_id: 'billing',
      auth: { mode: 'jwt', secret: REDACTED, header: 'Authorization' },
      transform_headers: {
        // An upstream header map is on ADR-0010's path list: hidden whole, names aside.
        request: { add: { Authorization: REDACTED, 'X-Api-Key': REDACTED, 'X-Env': REDACTED } },
      },
      graphql: { schema_sync: { headers: { authorization: REDACTED }, interval_ms: 1000 } },
      cors: { allow_credentials: true },
      versioning: { key: 'x-version' },
    });
  });

  it('hides key-session credentials', () => {
    expect(
      redactSnapshot({
        hmac: { secret: 's' },
        basic_auth: { password_hash: '$2b$12$abc' },
        alias: 'a',
      }),
    ).toEqual({ hmac: { secret: REDACTED }, basic_auth: { password_hash: REDACTED }, alias: 'a' });
  });

  it('marks a secret that changed against the other snapshot, never showing either value', () => {
    const before = { hmac: { secret: 'old' }, auth: { secret: 'same' } };
    const after = { hmac: { secret: 'new' }, auth: { secret: 'same' } };
    expect(redactSnapshot(after, before)).toEqual({
      hmac: { secret: REDACTED_CHANGED },
      auth: { secret: REDACTED },
    });
  });

  it('walks arrays and leaves nulls alone', () => {
    expect(redactSnapshot([{ token: 't' }, { token: null }])).toEqual([
      { token: REDACTED },
      { token: null },
    ]);
  });
});

describe('redactSnapshot on ADR-0010’s typed paths', () => {
  const upstream = { 'X-Upstream-Key': 'live-key', 'X-Env': 'prod' };

  it('hides an upstream header whose name is not credential-like, top level and per version', () => {
    const api = {
      api_id: 'billing',
      transform_headers: {
        request: { add: upstream },
        // Response headers go to clients: only the name rule applies there.
        response: { add: { 'X-Served-By': 'g2way' } },
      },
      graphql: {
        schema_sync: { headers: upstream },
        data_sources: { 'Query.user': { kind: 'rest', url: 'http://u', headers: upstream } },
        supergraph: { subgraphs: [{ name: 'a', url: 'http://a', headers: upstream }] },
      },
      versioning: {
        key: 'v',
        versions: { v2: { transform_headers: { request: { add: upstream } } } },
      },
    };
    const hidden = { 'X-Upstream-Key': REDACTED, 'X-Env': REDACTED };
    const redacted = redactSnapshot(api, null, 'api');
    expect(redacted).toEqual({
      api_id: 'billing',
      transform_headers: {
        request: { add: hidden },
        response: { add: { 'X-Served-By': 'g2way' } },
      },
      graphql: {
        schema_sync: { headers: hidden },
        data_sources: { 'Query.user': { kind: 'rest', url: 'http://u', headers: hidden } },
        supergraph: { subgraphs: [{ name: 'a', url: 'http://a', headers: hidden }] },
      },
      versioning: {
        key: 'v',
        versions: { v2: { transform_headers: { request: { add: hidden } } } },
      },
    });
    expect(JSON.stringify(redacted)).not.toContain('live-key');
  });

  it('marks an upstream header that changed', () => {
    const before = { transform_headers: { request: { add: { 'X-Upstream-Key': 'old' } } } };
    const after = { transform_headers: { request: { add: { 'X-Upstream-Key': 'new' } } } };
    expect(redactSnapshot(after, before, 'api')).toEqual({
      transform_headers: { request: { add: { 'X-Upstream-Key': REDACTED_CHANGED } } },
    });
  });

  it('applies every kind’s paths when the action names none', () => {
    expect(snapshotKind('api.update')).toBe('api');
    expect(snapshotKind('policy.bulk')).toBe('policy');
    expect(snapshotKind('key.create')).toBe('key');
    expect(snapshotKind('user.create')).toBeNull();
    expect(snapshotKind('gateway.reload')).toBeNull();
    const body = { transform_headers: { request: { add: { 'X-Upstream-Key': 'k' } } } };
    expect(redactSnapshot(body)).toEqual({
      transform_headers: { request: { add: { 'X-Upstream-Key': REDACTED } } },
    });
    // With a kind, only that kind's paths (plus the name rule) apply.
    expect(redactSnapshot(body, null, 'key')).toEqual(body);
  });
});

describe('redactSnapshot on URLs', () => {
  it('hides URL credentials on the typed fields and keeps the rest readable', () => {
    const api = {
      target_url: 'https://svc:hunter2@billing.internal:8443/api?region=eu&api_key=k1#top',
      target_list: ['http://a.internal?token=t1', 'http://b.internal'],
      graphql: {
        schema_sync: { url: 'https://introspect.internal/graphql?access_token=t2' },
        data_sources: { 'Query.u': { kind: 'rest', url: 'http://u/{{ args.id }}?sig=s1' } },
        supergraph: { subgraphs: [{ name: 'a', url: 'http://ops:pw@a/graphql' }] },
      },
      versioning: { versions: { v2: { target_url: 'http://u:p@v2.internal/' } } },
    };
    const redacted = redactSnapshot(api, null, 'api');
    const r = REDACTED_URL;
    expect(redacted).toEqual({
      target_url: `https://${r}@billing.internal:8443/api?region=eu&api_key=${r}#top`,
      target_list: [`http://a.internal?token=${r}`, 'http://b.internal'],
      graphql: {
        schema_sync: { url: `https://introspect.internal/graphql?access_token=${r}` },
        data_sources: { 'Query.u': { kind: 'rest', url: `http://u/{{ args.id }}?sig=${r}` } },
        supergraph: { subgraphs: [{ name: 'a', url: `http://${r}@a/graphql` }] },
      },
      versioning: { versions: { v2: { target_url: `http://${r}@v2.internal/` } } },
    });
    const text = JSON.stringify(redacted);
    for (const secret of ['hunter2', 'k1', 't1', 't2', 's1', 'ops:pw', 'u:p@']) {
      expect(text).not.toContain(secret);
    }
    expect(new URL(String((redacted as { target_url: string }).target_url)).hostname).toBe(
      'billing.internal',
    );
  });

  it('hides credentials in any other URL too, e.g. an untyped plugin config', () => {
    expect(redactSnapshot({ plugins: { config: { hook: 'https://h/x?key=abc' } } })).toEqual({
      plugins: { config: { hook: `https://h/x?key=${REDACTED_URL}` } },
    });
  });

  it('marks URL credentials that changed while the rest stayed the same', () => {
    const before = { target_url: 'http://u:old@h/?api_key=a' };
    expect(redactSnapshot({ target_url: 'http://u:new@h/?api_key=a' }, before, 'api')).toEqual({
      target_url: `http://${REDACTED_CHANGED_URL}@h/?api_key=${REDACTED_CHANGED_URL}`,
    });
    expect(redactSnapshot({ target_url: 'http://u:old@h/?api_key=a' }, before, 'api')).toEqual({
      target_url: `http://${REDACTED_URL}@h/?api_key=${REDACTED_URL}`,
    });
    // The host changed as well: the diff shows that, the credentials read plain redacted.
    expect(redactSnapshot({ target_url: 'http://u:new@g/' }, before, 'api')).toEqual({
      target_url: `http://${REDACTED_URL}@g/`,
    });
  });
});

describe('capSnapshot', () => {
  it('drops an oversized snapshot with a note', () => {
    const big = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1);
    const capped = capSnapshot('after', big);
    expect(capped.value).toBeNull();
    expect(capped.note).toMatch(/^after not stored: \d+ bytes/);
    expect(capSnapshot('after', { a: 1 })).toEqual({ value: { a: 1 } });
  });
});
