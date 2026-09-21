import { describe, expect, it } from 'vitest';
import spec from '../../../contracts/openapi.json';
import {
  compileBodyOrgScoped,
  compileOrgScoped,
  isBodyOrgScoped,
  isOrgScoped,
  scopeBody,
  topLevelKeys,
  withOrgId,
} from './org-scope';

describe('org scoping', () => {
  it('is derived from the operations declaring ?org_id= in the spec', () => {
    const scoped = compileOrgScoped(spec.paths);
    expect(scoped).toContain('GET /g2/apis');
    expect(scoped).toContain('DELETE /g2/policies/{id}');
    expect(scoped).toContain('GET /g2/keys/{key}');
    // Upstream takes the org from the body on these, not the query.
    expect(scoped).not.toContain('POST /g2/apis');
    expect(scoped).not.toContain('PUT /g2/apis/{id}');
    expect(scoped).not.toContain('POST /g2/reload');
  });

  it('matches methods case-insensitively', () => {
    expect(isOrgScoped('get', '/g2/apis')).toBe(true);
    expect(isOrgScoped('GET', '/g2/version')).toBe(false);
  });

  it('overwrites a caller-supplied org_id and keeps the rest of the query', () => {
    const url = new URL('http://gw/g2/keys/k?hashed=true&org_id=other');
    expect(withOrgId(url, 'GET', '/g2/keys/{key}', 'acme').toString()).toBe(
      'http://gw/g2/keys/k?hashed=true&org_id=acme',
    );
  });

  it('returns the same URL for an operation without org_id', () => {
    const url = new URL('http://gw/g2/reload');
    expect(withOrgId(url, 'POST', '/g2/reload', 'acme')).toBe(url);
  });
});

describe('body org scoping', () => {
  const ORG = 'acme';

  it('covers every write whose body schema carries org_id, and nothing else', () => {
    expect([...compileBodyOrgScoped(spec)].sort()).toEqual([
      'POST /g2/apis',
      'POST /g2/keys',
      'POST /g2/policies',
      'PUT /g2/apis/{id}',
      'PUT /g2/keys/{key}',
      'PUT /g2/policies/{id}',
    ]);
    expect(isBodyOrgScoped('put', '/g2/apis/{id}')).toBe(true);
    expect(isBodyOrgScoped('POST', '/g2/reload')).toBe(false);
  });

  it('adds the configured org when the body names none, keeping the rest byte for byte', () => {
    const body = '{\n  "id": "orders", "quota": {"max": 18446744073709551615}\n}';
    const scoped = scopeBody('POST', '/g2/apis', body, ORG);
    expect(scoped).toEqual({
      ok: true,
      body: '{"org_id":"acme",\n  "id": "orders", "quota": {"max": 18446744073709551615}\n}',
    });
    expect(JSON.parse((scoped as { body: string }).body)).toMatchObject({
      org_id: ORG,
      id: 'orders',
    });
    expect(scopeBody('PUT', '/g2/keys/{key}', ' {} ', ORG)).toEqual({
      ok: true,
      body: ' {"org_id":"acme"} ',
    });
  });

  it('passes a body already naming the configured org through unchanged', () => {
    const body = '{"name":"Gold","org_id":"acme","rate":1e2}';
    expect(scopeBody('PUT', '/g2/policies/{id}', body, ORG)).toEqual({ ok: true, body });
  });

  it('refuses a body naming another org: a cross-tenant write', () => {
    for (const org of ['other', '', null, 7, 'ACME']) {
      const scoped = scopeBody('POST', '/g2/keys', JSON.stringify({ org_id: org }), ORG);
      expect(scoped).toMatchObject({ ok: false, reason: 'cross-org' });
      expect((scoped as { message: string }).message).toMatch(/cross-org write refused/);
    }
  });

  it('refuses a body naming org_id twice, whichever one JSON.parse would keep', () => {
    for (const body of [
      '{"org_id":"acme","org_id":"other"}',
      '{"org_id":"other","org_id":"acme"}',
      '{"org\\u005fid":"other","org_id":"acme"}',
    ]) {
      expect(scopeBody('POST', '/g2/apis', body, ORG)).toMatchObject({
        ok: false,
        reason: 'cross-org',
      });
    }
  });

  it('refuses a body that is not a JSON object, since its org cannot be checked', () => {
    for (const body of ['', 'not json', '[]', 'null', '"x"']) {
      expect(scopeBody('POST', '/g2/policies', body, ORG)).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('leaves other operations alone', () => {
    expect(scopeBody('POST', '/g2/reload', 'anything', ORG)).toEqual({
      ok: true,
      body: 'anything',
    });
  });
});

describe('topLevelKeys', () => {
  it('lists only the top level, with duplicates, decoding escapes', () => {
    expect(
      topLevelKeys(
        '{"a":{"org_id":1},"b":["org_id",{"c":"}"}],"d\\"q":"x:\\"y","a" : 2,"org\\u005fid":3}',
      ),
    ).toEqual(['a', 'b', 'd"q', 'a', 'org_id']);
  });
});
