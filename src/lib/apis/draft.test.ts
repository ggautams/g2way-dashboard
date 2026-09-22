import { describe, expect, it } from 'vitest';
import {
  draftProblems,
  newDraft,
  otherFields,
  parseTargetList,
  parseWholeNumber,
  slugify,
  withAuthMode,
  withField,
} from './draft';
import type { ApiDefinition } from './list';

const stored: ApiDefinition = {
  api_id: 'orders',
  name: 'Orders',
  listen_path: '/orders/',
  target_url: 'http://orders:80',
  org_id: 'acme',
  auth: { mode: 'jwt', signing_method: 'hs256', secret: 'shh' },
  cors: { allowed_origins: ['https://app.example'] } as ApiDefinition['cors'],
  transform_method: 'POST',
};

describe('withField', () => {
  it('changes one field and keeps every other one, including ones the form never shows', () => {
    const next = withField(stored, 'name', 'Orders v2');
    expect(next).toEqual({ ...stored, name: 'Orders v2' });
    expect(stored.name).toBe('Orders');
  });

  it('removes an optional field given undefined, meaning g2way’s default', () => {
    expect(withField({ ...stored, upstream_retries: 3 }, 'upstream_retries', undefined)).toEqual(
      stored,
    );
  });
});

describe('otherFields', () => {
  it('names what the form does not edit, not org_id', () => {
    expect(otherFields(stored)).toEqual(['cors']);
    expect(otherFields(newDraft())).toEqual([]);
  });
});

describe('withAuthMode', () => {
  it('restores the loaded config when switching back to its mode', () => {
    const keyless = withAuthMode(stored, 'keyless', stored.auth);
    expect(keyless.auth).toEqual({ mode: 'keyless' });
    expect(withAuthMode(keyless, 'jwt', stored.auth).auth).toEqual(stored.auth);
  });

  it('writes token auth as no auth at all, g2way’s default', () => {
    expect(withAuthMode(stored, 'auth_token', stored.auth)).not.toHaveProperty('auth');
    const explicit = { ...stored, auth: { mode: 'auth_token' as const, header: 'X-Key' } };
    expect(withAuthMode(explicit, 'auth_token', explicit.auth).auth).toEqual(explicit.auth);
  });

  it('starts other modes from their required shape', () => {
    expect(withAuthMode(newDraft(), 'oidc', undefined).auth).toEqual({
      mode: 'oidc',
      issuer_url: '',
      audiences: [],
    });
    expect(withAuthMode(newDraft(), 'jwt', undefined).auth).toEqual({
      mode: 'jwt',
      signing_method: 'rs256',
    });
  });
});

describe('field parsing', () => {
  it('reads a target list one URL per line, blank meaning none', () => {
    expect(parseTargetList(' http://a \n\n http://b ')).toEqual(['http://a', 'http://b']);
    expect(parseTargetList('  \n ')).toBeUndefined();
  });

  it('reads whole numbers in range, blank meaning the default', () => {
    expect(parseWholeNumber('', 0, 10)).toEqual({ ok: true, value: undefined });
    expect(parseWholeNumber(' 7 ', 0, 10)).toEqual({ ok: true, value: 7 });
    expect(parseWholeNumber('11', 0, 10)).toMatchObject({ ok: false });
    expect(parseWholeNumber('1.5', 1)).toMatchObject({ ok: false, problem: /at least 1/ });
  });

  it('slugifies a name into an id', () => {
    expect(slugify('  Crème Brûlée API v2! ')).toBe('creme-brulee-api-v2');
  });
});

describe('draftProblems', () => {
  it('flags the required fields of a new draft', () => {
    expect(Object.keys(draftProblems(newDraft())).sort()).toEqual(['api_id', 'name', 'target_url']);
  });

  it('checks the contract’s rules, and passes a sound definition', () => {
    expect(draftProblems(stored)).toEqual({});
    expect(
      draftProblems({
        ...stored,
        api_id: 'a/b',
        listen_path: 'orders',
        target_list: ['http://ok', 'ftp://no'],
      }),
    ).toEqual({
      api_id: 'No spaces, slashes, ? or #.',
      listen_path: 'Must begin with /.',
      target_list: 'Not an absolute http(s) URL: ftp://no',
    });
  });

  it('checks the method override, size limit and IP lists as g2way validates them', () => {
    expect(
      draftProblems({
        ...stored,
        transform_method: 'CONNECT',
        max_request_body_bytes: 0,
        allow_ips: ['10.0.0.0/8', 'not-an-ip'],
        block_ips: ['10.0.0.0/99'],
      }),
    ).toEqual({
      transform_method: expect.stringContaining('CONNECT'),
      max_request_body_bytes: expect.stringContaining('greater than zero'),
      allow_ips: 'Not an IP address or CIDR network: not-an-ip',
      block_ips: 'Not an IP address or CIDR network: 10.0.0.0/99',
    });
    expect(
      draftProblems({ ...stored, transform_method: 'patch', max_request_body_bytes: null }),
    ).toEqual({});
  });

  it('reports auth settings under auth.<setting>', () => {
    expect(
      draftProblems({ ...stored, auth: { mode: 'jwt', signing_method: 'hs256', secret: ' ' } }),
    ).toEqual({ 'auth.secret': 'hs256 needs a secret.' });
  });
});
