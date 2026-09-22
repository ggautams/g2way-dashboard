import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_QUERY_PARAMS,
  isCredentialParam,
  looksLikeUrl,
  maskUrlCredentials,
} from './url';

const M = '%5Bmask%5D';

describe('maskUrlCredentials', () => {
  it('masks the userinfo, keeping scheme, host, port, path, query and fragment', () => {
    expect(maskUrlCredentials('https://ada:hunter2@api.internal:8443/v1?region=eu#top', M)).toBe(
      `https://${M}@api.internal:8443/v1?region=eu#top`,
    );
    // A user alone (a token used as the username) is a credential too.
    expect(maskUrlCredentials('https://ghp_abc@github.com/org/repo', M)).toBe(
      `https://${M}@github.com/org/repo`,
    );
  });

  it('masks only credential query values', () => {
    expect(maskUrlCredentials('http://h/p?region=eu&api_key=k&page=2&token=t', M)).toBe(
      `http://h/p?region=eu&api_key=${M}&page=2&token=${M}`,
    );
  });

  it('matches parameter names after decoding, case and dashes', () => {
    expect(
      maskUrlCredentials(
        'https://b.s3.amazonaws.com/o?X-Amz-Credential=c&X-Amz-Signature=s&X-Amz-Expires=60',
        M,
      ),
    ).toBe(
      `https://b.s3.amazonaws.com/o?X-Amz-Credential=${M}&X-Amz-Signature=${M}&X-Amz-Expires=60`,
    );
    expect(maskUrlCredentials('http://h?API-KEY=k&Api%5FKey=k2', M)).toBe(
      `http://h?API-KEY=${M}&Api%5FKey=${M}`,
    );
  });

  it('leaves empty and valueless parameters alone', () => {
    expect(maskUrlCredentials('http://h?token=&key&x=1', M)).toBe('http://h?token=&key&x=1');
  });

  it('leaves a URL without credentials unchanged', () => {
    for (const url of ['http://billing.svc:8000/api', 'http://h/?keyword=a&token_type=b', '']) {
      expect(maskUrlCredentials(url, M)).toBe(url);
    }
  });

  it('does not take an @ in the path or query for userinfo', () => {
    expect(maskUrlCredentials('http://h/users/@ada?email=a@b', M)).toBe(
      'http://h/users/@ada?email=a@b',
    );
  });

  it('works on minijinja templates a URL parser would reject', () => {
    expect(maskUrlCredentials('http://u:p@users/{{ args.id }}?key={{ vars.k }}', M)).toBe(
      `http://${M}@users/{{ args.id }}?key=${M}`,
    );
    // No scheme: no userinfo to find, but the query is still checked.
    expect(maskUrlCredentials('{{ vars.base }}/x?token=t', M)).toBe(`{{ vars.base }}/x?token=${M}`);
  });

  it('is idempotent and keeps the result parseable', () => {
    const once = maskUrlCredentials('https://a:b@h.example/p?sig=s&x=1', '%5Bsecret%20hidden%5D');
    expect(maskUrlCredentials(once, '%5Bsecret%20hidden%5D')).toBe(once);
    const url = new URL(once);
    expect(url.hostname).toBe('h.example');
    expect(url.pathname).toBe('/p');
    expect(url.searchParams.get('sig')).toBe('[secret hidden]');
    expect(url.searchParams.get('x')).toBe('1');
    expect(decodeURIComponent(url.username)).toBe('[secret hidden]');
  });
});

describe('credential parameter names', () => {
  it('is an explicit list', () => {
    expect([...CREDENTIAL_QUERY_PARAMS].sort()).toEqual(
      [
        'access_token',
        'api_key',
        'apikey',
        'auth',
        'auth_token',
        'authorization',
        'bearer',
        'client_secret',
        'credential',
        'credentials',
        'id_token',
        'jwt',
        'key',
        'passwd',
        'password',
        'private_key',
        'pwd',
        'refresh_token',
        'secret',
        'session',
        'session_id',
        'sessionid',
        'sig',
        'signature',
        'token',
        'x_amz_credential',
        'x_amz_security_token',
        'x_amz_signature',
        'x_api_key',
        'x_goog_credential',
        'x_goog_signature',
      ].sort(),
    );
  });

  it('does not match look-alikes', () => {
    for (const name of ['keyword', 'token_type', 'monkey', 'region', 'page', 'expires']) {
      expect(isCredentialParam(name)).toBe(false);
    }
    for (const name of ['api_key', 'Api-Key', 'TOKEN', 'x-amz-signature', 'sig']) {
      expect(isCredentialParam(name)).toBe(true);
    }
  });
});

describe('looksLikeUrl', () => {
  it('wants a scheme and an authority', () => {
    expect(looksLikeUrl('https://h')).toBe(true);
    expect(looksLikeUrl('redis+tls://h:6379')).toBe(true);
    expect(looksLikeUrl('/relative?token=t')).toBe(false);
    expect(looksLikeUrl('Bearer abc')).toBe(false);
    expect(looksLikeUrl('mailto:a@b')).toBe(false);
  });
});
