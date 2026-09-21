import { describe, expect, it } from 'vitest';
import spec from '../../../contracts/openapi.json';
import { compileOrgScoped, isOrgScoped, withOrgId } from './org-scope';

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
