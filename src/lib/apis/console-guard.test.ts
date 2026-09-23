import { describe, expect, it } from 'vitest';
import { CONSOLE_MAX_REQUEST_BYTES } from './console';
import {
  CONSOLE_MAX_HEADERS,
  consoleTarget,
  gatewayErrorOf,
  isTextual,
  parseConsoleRequest,
} from './console-guard';

const VALID = { apiId: 'users', method: 'get', path: '42', headers: [], body: '', version: null };

describe('parseConsoleRequest', () => {
  it('accepts a well-formed request and upper-cases the method', () => {
    expect(parseConsoleRequest(VALID)).toEqual({
      ok: true,
      value: { ...VALID, method: 'GET' },
    });
    const withVersion = parseConsoleRequest({ ...VALID, version: 'v2', headers: [['A', 'b']] });
    expect(withVersion.ok && withVersion.value.version).toBe('v2');
  });

  it.each([
    [null, 'expected a JSON object'],
    [{ ...VALID, apiId: '' }, 'apiId'],
    [{ ...VALID, method: 'TRACE' }, 'method must be one of'],
    [{ ...VALID, method: 'CONNECT' }, 'method must be one of'],
    [{ ...VALID, path: 1 }, 'path must be a string'],
    [{ ...VALID, body: null }, 'body must be a string'],
    [{ ...VALID, version: '' }, 'version'],
    [{ ...VALID, headers: {} }, 'headers must be a list'],
    [{ ...VALID, headers: [['a']] }, '[name, value] pair'],
    [{ ...VALID, headers: [['bad name', 'x']] }, 'not a valid header name'],
    [{ ...VALID, headers: [['X-A', 'a\r\nInjected: 1']] }, 'control characters'],
    [{ ...VALID, headers: [['Host', 'evil.example']] }, 'cannot be set'],
    [{ ...VALID, headers: [['X-G2-Authorization', 's']] }, 'cannot be set'],
    [{ ...VALID, headers: [['Transfer-Encoding', 'chunked']] }, 'cannot be set'],
    [{ ...VALID, headers: [['Content-Length', '1']] }, 'cannot be set'],
  ])('refuses %j', (input, message) => {
    const parsed = parseConsoleRequest(input);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(message);
  });

  it('caps the body and the header count', () => {
    const big = parseConsoleRequest({ ...VALID, body: 'x'.repeat(CONSOLE_MAX_REQUEST_BYTES + 1) });
    expect(!big.ok && big.error).toContain('cap');
    const many = parseConsoleRequest({
      ...VALID,
      headers: Array.from({ length: CONSOLE_MAX_HEADERS + 1 }, (_, i) => [`X-${i}`, '1']),
    });
    expect(!many.ok && many.error).toContain(`at most ${CONSOLE_MAX_HEADERS}`);
  });
});

describe('consoleTarget (the SSRF guard)', () => {
  const PROXY = 'http://gw.internal:8080';

  function target(suffix: string, listen = '/users/', proxy = PROXY) {
    const result = consoleTarget(proxy, listen, suffix);
    return result.ok ? result.value : result.error;
  }

  it('joins the proxy base, the listen path and the suffix', () => {
    const value = target('42?full=1');
    expect(typeof value !== 'string' && value.url.toString()).toBe(
      'http://gw.internal:8080/users/42?full=1',
    );
    expect(typeof value !== 'string' && [value.path, value.query]).toEqual(['/users/42', 'full=1']);
  });

  it('keeps the listen path’s own shape for an empty suffix, and tolerates a leading slash', () => {
    expect(typeof target('') !== 'string' && (target('') as { path: string }).path).toBe('/users/');
    expect((target('', '/users') as { path: string }).path).toBe('/users');
    expect((target('/42') as { path: string }).path).toBe('/users/42');
    expect((target('?q=1') as { query: string }).query).toBe('q=1');
  });

  it('honours a path prefix on the proxy URL (an ingress mount)', () => {
    const value = target('42', '/users/', 'https://edge.example/gw');
    expect(typeof value !== 'string' && value.url.toString()).toBe(
      'https://edge.example/gw/users/42',
    );
    expect(typeof value !== 'string' && value.path).toBe('/users/42');
  });

  it.each([
    ['../admin', 'must stay under'],
    ['a/../../admin', 'must stay under'],
    ['%2e%2e/admin', 'must stay under'],
    ['.%2E/admin', 'must stay under'],
    ['%2f%2fevil.example/x', 'encoded slashes'],
    ['%5c..%5cadmin', 'encoded slashes'],
    ['..\\admin', 'backslashes'],
    ['x#frag', '#'],
    ['a b', 'spaces'],
    ['a\nb', 'control characters'],
  ])('refuses %j', (suffix, message) => {
    expect(target(suffix)).toContain(message);
  });

  it('can never change the host, scheme or port', () => {
    for (const suffix of [
      '//evil.example/x',
      '@evil.example',
      'http://evil.example/',
      ':9696/g2',
    ]) {
      const value = target(suffix);
      if (typeof value === 'string') continue;
      expect(value.url.origin).toBe('http://gw.internal:8080');
      expect(value.url.pathname.startsWith('/users/')).toBe(true);
    }
  });

  it('refuses ../ past a listen path of / only when it would leave the proxy base', () => {
    expect((target('a/../b', '/') as { path: string }).path).toBe('/b');
    expect(target('../../x', '/', 'https://edge.example/gw')).toContain('must stay under');
  });
});

describe('isTextual', () => {
  it.each([
    ['application/json; charset=utf-8', true],
    ['text/html', true],
    ['application/problem+json', true],
    ['application/xml', true],
    [null, true],
    ['image/png', false],
    ['application/octet-stream', false],
  ])('%s → %s', (type, expected) => {
    expect(isTextual(type)).toBe(expected);
  });
});

describe('gatewayErrorOf', () => {
  it("reads g2way's envelope, verbatim, and nothing else", () => {
    expect(gatewayErrorOf('{"error":"missing credential"}')).toBe('missing credential');
    expect(gatewayErrorOf('{"error":"x","detail":1}')).toBeNull();
    expect(gatewayErrorOf('{"error":1}')).toBeNull();
    expect(gatewayErrorOf('not json')).toBeNull();
    expect(gatewayErrorOf('["error"]')).toBeNull();
  });
});
